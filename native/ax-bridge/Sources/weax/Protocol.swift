import ApplicationServices
import Foundation

/// A fully dynamic JSON value. Used for both request params and response payloads
/// so the bridge never has to know a fixed shape for arbitrary AX attributes.
indirect enum JSONValue: Codable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let v = try? c.decode(Bool.self) { self = .bool(v); return }
        if let v = try? c.decode(Int.self) { self = .int(v); return }
        if let v = try? c.decode(Double.self) { self = .double(v); return }
        if let v = try? c.decode(String.self) { self = .string(v); return }
        if let v = try? c.decode([JSONValue].self) { self = .array(v); return }
        if let v = try? c.decode([String: JSONValue].self) { self = .object(v); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON value")
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .int(let v): try c.encode(v)
        case .double(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
}

// MARK: - Accessors

extension JSONValue {
    var stringValue: String? { if case .string(let v) = self { return v }; return nil }
    var boolValue: Bool? { if case .bool(let v) = self { return v }; return nil }
    var arrayValue: [JSONValue]? { if case .array(let v) = self { return v }; return nil }
    var objectValue: [String: JSONValue]? { if case .object(let v) = self { return v }; return nil }

    var intValue: Int? {
        switch self {
        case .int(let v): return v
        case .double(let v): return Int(v)
        default: return nil
        }
    }

    var doubleValue: Double? {
        switch self {
        case .int(let v): return Double(v)
        case .double(let v): return v
        default: return nil
        }
    }
}

// MARK: - Request

struct Request {
    let id: Int
    let op: String
    let params: [String: JSONValue]

    /// Parses one NDJSON line. Throws BridgeError.badRequest on any malformed input.
    static func parse(line: Data) throws -> Request {
        let value: JSONValue
        do {
            value = try JSONDecoder().decode(JSONValue.self, from: line)
        } catch {
            throw BridgeError.badRequest("not valid JSON: \(error.localizedDescription)")
        }
        guard let obj = value.objectValue else { throw BridgeError.badRequest("request must be a JSON object") }
        guard let id = obj["id"]?.intValue else { throw BridgeError.badRequest("missing numeric 'id'") }
        guard let op = obj["op"]?.stringValue else { throw BridgeError.badRequest("missing string 'op'") }
        var params = obj
        params.removeValue(forKey: "id")
        params.removeValue(forKey: "op")
        return Request(id: id, op: op, params: params)
    }

    func require(_ key: String) throws -> JSONValue {
        guard let v = params[key] else { throw BridgeError.badRequest("missing param '\(key)'") }
        return v
    }

    func requireInt(_ key: String) throws -> Int {
        guard let v = try require(key).intValue else { throw BridgeError.badRequest("param '\(key)' must be a number") }
        return v
    }

    func requireString(_ key: String) throws -> String {
        guard let v = try require(key).stringValue else { throw BridgeError.badRequest("param '\(key)' must be a string") }
        return v
    }

    func int(_ key: String, default fallback: Int) -> Int { params[key]?.intValue ?? fallback }
    func bool(_ key: String, default fallback: Bool) -> Bool { params[key]?.boolValue ?? fallback }
    func string(_ key: String) -> String? { params[key]?.stringValue }
}

// MARK: - Errors

/// Stable, machine-readable error codes. The TypeScript side switches on `code`.
struct BridgeError: Error {
    let code: String
    let message: String

    static func badRequest(_ m: String) -> BridgeError { BridgeError(code: "BAD_REQUEST", message: m) }
    static func notTrusted() -> BridgeError {
        BridgeError(code: "NOT_TRUSTED",
                    message: "this process is not trusted for Accessibility; grant it in System Settings > Privacy & Security > Accessibility")
    }
    static func noSuchPid(_ pid: Int) -> BridgeError { BridgeError(code: "NO_SUCH_PID", message: "no running application with pid \(pid)") }
    static func noSuchNode(_ id: Int) -> BridgeError { BridgeError(code: "NO_SUCH_NODE", message: "unknown nodeId \(id)") }
    static func noSuchSubscription(_ id: Int) -> BridgeError {
        BridgeError(code: "NO_SUCH_SUBSCRIPTION", message: "unknown subscription \(id)")
    }
    static func ax(_ err: AXError, _ what: String) -> BridgeError {
        BridgeError(code: "AX_ERROR(\(err.rawValue))", message: "\(what) failed: \(axErrorName(err)) (\(err.rawValue))")
    }
    static func unknownOp(_ op: String) -> BridgeError { BridgeError(code: "BAD_REQUEST", message: "unknown op '\(op)'") }
}

func axErrorName(_ err: AXError) -> String {
    switch err {
    case .success: return "success"
    case .failure: return "failure"
    case .illegalArgument: return "illegalArgument"
    case .invalidUIElement: return "invalidUIElement"
    case .invalidUIElementObserver: return "invalidUIElementObserver"
    case .cannotComplete: return "cannotComplete"
    case .attributeUnsupported: return "attributeUnsupported"
    case .actionUnsupported: return "actionUnsupported"
    case .notificationUnsupported: return "notificationUnsupported"
    case .notImplemented: return "notImplemented"
    case .notificationAlreadyRegistered: return "notificationAlreadyRegistered"
    case .notificationNotRegistered: return "notificationNotRegistered"
    case .apiDisabled: return "apiDisabled"
    case .noValue: return "noValue"
    case .parameterizedAttributeUnsupported: return "parameterizedAttributeUnsupported"
    case .notEnoughPrecision: return "notEnoughPrecision"
    @unknown default: return "unknown"
    }
}
