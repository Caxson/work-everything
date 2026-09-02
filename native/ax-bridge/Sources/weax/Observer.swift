import ApplicationServices
import Foundation

/// One AXObserver plus the notifications registered on it. Kept alive by the registry
/// and by the retained pointer handed to the C callback.
final class Subscription {
    let id: Int
    let pid: pid_t
    let observer: AXObserver
    let element: AXUIElement
    let notifications: [String]
    var refcon: UnsafeMutableRawPointer?
    /// The client's channel and handle space, captured when the subscription was made.
    ///
    /// An event fires from the run loop, long after the request that registered it and
    /// with no request in flight — so `Connection.current` means nothing here. Holding the
    /// two things the event needs is what keeps a notification going to the client that
    /// asked for it, and its `nodeId` numbered in that client's space. Neither reference
    /// points back at the connection, so there is no cycle to break.
    private let sink: Output
    private let elements: ElementRegistry

    init(id: Int, pid: pid_t, observer: AXObserver, element: AXUIElement, notifications: [String],
         sink: Output, elements: ElementRegistry) {
        self.id = id
        self.pid = pid
        self.observer = observer
        self.element = element
        self.notifications = notifications
        self.sink = sink
        self.elements = elements
    }

    func deliver(element: AXUIElement, notification: String) {
        sink.emit(.object([
            "event": .string("ax"),
            "subscription": .int(id),
            "notification": .string(notification),
            "nodeId": .int(elements.handle(for: element)),
            "pid": .int(Int(pid))
        ]))
    }
}

/// C callbacks cannot capture context, so the subscription travels as `refcon`.
private let axObserverCallback: AXObserverCallback = { _, element, notification, refcon in
    guard let refcon = refcon else { return }
    let subscription = Unmanaged<Subscription>.fromOpaque(refcon).takeUnretainedValue()
    subscription.deliver(element: element, notification: notification as String)
}

/// Main-thread confined: AXObserver run loop sources are attached to the main run loop.
/// One registry per client (see `Connection`), so a dropped connection takes its own
/// subscriptions down and nobody else's.
final class ObserverRegistry {
    private var nextId = 1
    private var subscriptions: [Int: Subscription] = [:]

    func observe(pid: pid_t, element: AXUIElement, notifications: [String]) throws -> JSONValue {
        guard !notifications.isEmpty else { throw BridgeError.badRequest("'notifications' must not be empty") }
        var observer: AXObserver?
        let createErr = AXObserverCreate(pid, axObserverCallback, &observer)
        guard createErr == .success, let observer = observer else {
            throw BridgeError.ax(createErr, "AXObserverCreate for pid \(pid)")
        }

        let id = nextId
        nextId += 1
        let subscription = Subscription(id: id, pid: pid, observer: observer,
                                        element: element, notifications: notifications,
                                        sink: Output.current, elements: ElementRegistry.current)
        let refcon = Unmanaged.passRetained(subscription).toOpaque()
        subscription.refcon = refcon

        let registered = register(subscription, refcon: refcon)
        guard !registered.accepted.isEmpty else {
            Unmanaged<Subscription>.fromOpaque(refcon).release()
            throw BridgeError(code: "AX_ERROR(\(registered.lastError))",
                              message: "no notification could be registered: \(registered.rejected)")
        }

        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        subscriptions[id] = subscription
        return .object([
            "subscription": .int(id),
            "registered": .array(registered.accepted.map { .string($0) }),
            "failed": .object(registered.rejected.mapValues { .int(Int($0)) })
        ])
    }

    private func register(_ subscription: Subscription, refcon: UnsafeMutableRawPointer)
        -> (accepted: [String], rejected: [String: Int32], lastError: Int32) {
        var accepted: [String] = []
        var rejected: [String: Int32] = [:]
        var lastError: Int32 = 0
        for name in subscription.notifications {
            let err = AXObserverAddNotification(subscription.observer, subscription.element,
                                                name as CFString, refcon)
            if err == .success || err == .notificationAlreadyRegistered {
                accepted.append(name)
            } else {
                rejected[name] = err.rawValue
                lastError = err.rawValue
            }
        }
        return (accepted, rejected, lastError)
    }

    func unobserve(id: Int) throws -> JSONValue {
        guard let subscription = subscriptions.removeValue(forKey: id) else {
            throw BridgeError.noSuchSubscription(id)
        }
        for name in subscription.notifications {
            AXObserverRemoveNotification(subscription.observer, subscription.element, name as CFString)
        }
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(subscription.observer), .commonModes)
        if let refcon = subscription.refcon {
            Unmanaged<Subscription>.fromOpaque(refcon).release()
        }
        return .object(["subscription": .int(id), "ok": .bool(true)])
    }

    func teardownAll() {
        for id in subscriptions.keys { _ = try? unobserve(id: id) }
    }
}
