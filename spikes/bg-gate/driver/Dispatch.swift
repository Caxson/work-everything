// 后台事件投递：全部走 postToPid，绝不碰 .cghidEventTap（碰了就会动用户真实光标）
import AppKit
import CoreGraphics
import Foundation

struct DispatchOptions {
    var useWindowFields = true      // 51/58
    var useMouseWindowFields = true // 91/92
    var useWindowLocation = true    // CGEventSetWindowLocation
    var useTargetPID = true         // 40
}

enum BackgroundDispatcher {
    /// 单个鼠标事件。screenPoint 是 AX 全局屏幕坐标（左上原点）。
    @discardableResult
    static func postMouse(_ type: CGEventType,
                          pid: pid_t,
                          windowNumber: Int,
                          windowFrame: CGRect,
                          screenPoint: CGPoint,
                          clickState: Int64,
                          pressure: Double,
                          options: DispatchOptions) -> AddressingReport
    {
        var rep = AddressingReport()
        // 鼠标 source 用 nil（与键盘的 .hidSystemState 不同，别统一）
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type,
                                  mouseCursorPosition: screenPoint, mouseButton: .left) else { return rep }
        event.setIntegerValueField(.mouseEventClickState, value: clickState)
        event.setDoubleValueField(.mouseEventPressure, value: pressure)
        if options.useTargetPID {
            event.setIntegerValueField(EventField.targetPID, value: Int64(pid)); rep.field40 = true
        }
        if options.useMouseWindowFields {
            event.setIntegerValueField(EventField.windowUnderPointer, value: Int64(windowNumber)); rep.field91 = true
            event.setIntegerValueField(EventField.windowThatCanHandle, value: Int64(windowNumber)); rep.field92 = true
        }
        if options.useWindowFields {
            let r = event.applyPrivateWindowFields(windowNumber: windowNumber)
            rep.field51 = r.f51; rep.field58 = r.f58
        }
        if options.useWindowLocation {
            let q = Coords.quartz(fromAXScreen: screenPoint, frame: windowFrame)
            rep.quartzWindowPoint = [q.x, q.y]
            rep.windowLocationApplied = SPI.setWindowLocation(q, on: event)
        }
        event.postToPid(pid)
        return rep
    }

    @discardableResult
    static func leftClick(pid: pid_t, windowNumber: Int, windowFrame: CGRect,
                          screenPoint: CGPoint, options: DispatchOptions) -> AddressingReport
    {
        let r = postMouse(.leftMouseDown, pid: pid, windowNumber: windowNumber, windowFrame: windowFrame,
                          screenPoint: screenPoint, clickState: 1, pressure: 1, options: options)
        usleep(30_000)
        _ = postMouse(.leftMouseUp, pid: pid, windowNumber: windowNumber, windowFrame: windowFrame,
                      screenPoint: screenPoint, clickState: 1, pressure: 0, options: options)
        usleep(20_000)
        return r
    }

    // MARK: 键盘
    private static let keySource = CGEventSource(stateID: .hidSystemState)

    @discardableResult
    static func typeUnicode(_ text: String, pid: pid_t, windowNumber: Int, options: DispatchOptions) -> AddressingReport {
        var rep = AddressingReport()
        for cluster in text {
            let units: [UniChar] = Array(String(cluster).utf16)
            units.withUnsafeBufferPointer { buf in
                guard let base = buf.baseAddress, buf.count > 0,
                      let down = CGEvent(keyboardEventSource: keySource, virtualKey: 0, keyDown: true),
                      let up = CGEvent(keyboardEventSource: keySource, virtualKey: 0, keyDown: false) else { return }
                down.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: base)
                rep = postKey(down, pid: pid, windowNumber: windowNumber, options: options)
                up.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: base)
                _ = postKey(up, pid: pid, windowNumber: windowNumber, options: options)
            }
            usleep(4_000)
        }
        return rep
    }

    /// 组合键：修饰键用 flagsChanged（比 kwwk 的 keyDown/keyUp 正确），序列以 flags==0 收尾。
    static func pressCombo(keyCode: CGKeyCode, flags: CGEventFlags, pid: pid_t, windowNumber: Int, options: DispatchOptions) {
        if !flags.isEmpty, let fc = CGEvent(keyboardEventSource: keySource, virtualKey: 0, keyDown: true) {
            fc.type = .flagsChanged; fc.flags = flags
            _ = postKey(fc, pid: pid, windowNumber: windowNumber, options: options)
            usleep(8_000)
        }
        if let d = CGEvent(keyboardEventSource: keySource, virtualKey: keyCode, keyDown: true) {
            d.flags = flags; _ = postKey(d, pid: pid, windowNumber: windowNumber, options: options)
        }
        usleep(8_000)
        if let u = CGEvent(keyboardEventSource: keySource, virtualKey: keyCode, keyDown: false) {
            u.flags = flags; _ = postKey(u, pid: pid, windowNumber: windowNumber, options: options)
        }
        usleep(8_000)
        if !flags.isEmpty, let fc = CGEvent(keyboardEventSource: keySource, virtualKey: 0, keyDown: true) {
            fc.type = .flagsChanged; fc.flags = []
            _ = postKey(fc, pid: pid, windowNumber: windowNumber, options: options)
        }
        usleep(8_000)
    }

    @discardableResult
    static func postKey(_ event: CGEvent, pid: pid_t, windowNumber: Int, options: DispatchOptions) -> AddressingReport {
        var rep = AddressingReport()
        if options.useTargetPID {
            event.setIntegerValueField(EventField.targetPID, value: Int64(pid)); rep.field40 = true
        }
        if options.useWindowFields {
            let r = event.applyPrivateWindowFields(windowNumber: windowNumber)
            rep.field51 = r.f51; rep.field58 = r.f58
        }
        event.postToPid(pid)
        return rep
    }
}
