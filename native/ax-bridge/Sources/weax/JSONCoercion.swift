import ApplicationServices
import CoreGraphics
import Foundation

/// Generic CFTypeRef -> JSONValue conversion. Everything the AX API can hand back
/// goes through here; nothing is special-cased per application.
enum JSONCoercion {
    static let maxStringLength = 200

    static func toJSON(_ value: CFTypeRef?, truncate: Bool = true) -> JSONValue {
        guard let value = value else { return .null }
        let typeId = CFGetTypeID(value)

        switch typeId {
        case CFStringGetTypeID():
            let s = value as! CFString as String
            return .string(truncate ? clip(s) : s)
        case CFBooleanGetTypeID():
            return .bool(CFBooleanGetValue((value as! CFBoolean)))
        case CFNumberGetTypeID():
            return number(value as! CFNumber)
        case CFArrayGetTypeID():
            let arr = value as! CFArray as [AnyObject]
            return .array(arr.map { toJSON($0 as CFTypeRef, truncate: truncate) })
        case CFDictionaryGetTypeID():
            return dictionary(value, truncate: truncate)
        case AXUIElementGetTypeID():
            let element = value as! AXUIElement
            return .object(["nodeId": .int(ElementRegistry.current.handle(for: element))])
        case AXValueGetTypeID():
            return axValue(value as! AXValue)
        case CFURLGetTypeID():
            return .string((value as! CFURL as URL).absoluteString)
        case CFNullGetTypeID():
            return .null
        default:
            return .string(clip(String(describing: value)))
        }
    }

    private static func clip(_ s: String) -> String {
        guard s.count > maxStringLength else { return s }
        return String(s.prefix(maxStringLength)) + "…"
    }

    private static func number(_ n: CFNumber) -> JSONValue {
        if CFNumberIsFloatType(n) {
            var d: Double = 0
            CFNumberGetValue(n, .doubleType, &d)
            return d.isFinite ? .double(d) : .null
        }
        var i: Int = 0
        CFNumberGetValue(n, .nsIntegerType, &i)
        return .int(i)
    }

    private static func dictionary(_ value: CFTypeRef, truncate: Bool) -> JSONValue {
        guard let dict = value as? [String: AnyObject] else { return .null }
        var out: [String: JSONValue] = [:]
        for (k, v) in dict { out[k] = toJSON(v as CFTypeRef, truncate: truncate) }
        return .object(out)
    }

    private static func axValue(_ value: AXValue) -> JSONValue {
        switch AXValueGetType(value) {
        case .cgPoint:
            var p = CGPoint.zero
            AXValueGetValue(value, .cgPoint, &p)
            return .object(["x": .double(p.x), "y": .double(p.y)])
        case .cgSize:
            var s = CGSize.zero
            AXValueGetValue(value, .cgSize, &s)
            return .object(["w": .double(s.width), "h": .double(s.height)])
        case .cgRect:
            var r = CGRect.zero
            AXValueGetValue(value, .cgRect, &r)
            return .object(["x": .double(r.origin.x), "y": .double(r.origin.y),
                            "w": .double(r.size.width), "h": .double(r.size.height)])
        case .cfRange:
            var range = CFRange(location: 0, length: 0)
            AXValueGetValue(value, .cfRange, &range)
            return .object(["location": .int(range.location), "length": .int(range.length)])
        case .axError:
            return .null  // multi-attribute fetch failure placeholder
        default:
            return .null
        }
    }

    /// True when a multi-attribute fetch returned an embedded AXError placeholder.
    static func isErrorPlaceholder(_ value: CFTypeRef?) -> Bool {
        guard let value = value, CFGetTypeID(value) == AXValueGetTypeID() else { return false }
        return AXValueGetType(value as! AXValue) == .axError
    }

    /// JSONValue -> CFTypeRef for setValue. Only scalars are supported on purpose.
    static func toCF(_ value: JSONValue) throws -> CFTypeRef {
        switch value {
        case .string(let s): return s as CFString
        case .bool(let b): return b ? kCFBooleanTrue : kCFBooleanFalse
        case .int(let i): return i as CFNumber
        case .double(let d): return d as CFNumber
        default: throw BridgeError.badRequest("value must be a string, number or boolean")
        }
    }
}
