"use strict";

/**
 * Builds 3GPP SMS-DELIVER PDUs (GSM 03.40 / 03.38) for injecting inbound SMS
 * into a nubo phone via `am inject-nubo-sms --pdu <HEX>`.
 *
 * Reproduces the same PDU format the management server used to build for
 * `nubo_sms_pdu`: no SMSC, international originating address, GSM 7-bit default
 * alphabet, with automatic UCS2 fallback for unicode and concatenation (UDH)
 * for messages longer than a single segment.
 */

// GSM 03.38 default alphabet, indexed by septet value (0x00-0x7F).
// 0x1B is the escape to the extension table and is not a printable char.
const GSM7_BASIC_CODEPOINTS = [
    0x40, 0xA3, 0x24, 0xA5, 0xE8, 0xE9, 0xF9, 0xEC, 0xF2, 0xC7, 0x0A, 0xD8, 0xF8, 0x0D, 0xC5, 0xE5,
    0x394, 0x5F, 0x3A6, 0x393, 0x39B, 0x3A9, 0x3A0, 0x3A8, 0x3A3, 0x398, 0x39E, 0x1B, 0xC6, 0xE6, 0xDF, 0xC9,
    0x20, 0x21, 0x22, 0x23, 0xA4, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F,
    0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F,
    0xA1, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x4B, 0x4C, 0x4D, 0x4E, 0x4F,
    0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0xC4, 0xD6, 0xD1, 0xDC, 0xA7,
    0xBF, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x6B, 0x6C, 0x6D, 0x6E, 0x6F,
    0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0xE4, 0xF6, 0xF1, 0xFC, 0xE0
];

// GSM 03.38 extension table: char -> septet value (sent after a 0x1B escape).
const GSM7_EXT = {
    "\f": 0x0A, "^": 0x14, "{": 0x28, "}": 0x29, "\\": 0x2F,
    "[": 0x3C, "~": 0x3D, "]": 0x3E, "|": 0x40, "€": 0x65
};

const GSM7_BASIC = (function () {
    const map = {};
    for (let i = 0; i < GSM7_BASIC_CODEPOINTS.length; i++) {
        if (i === 0x1B) continue; // escape slot, not a real character
        map[String.fromCodePoint(GSM7_BASIC_CODEPOINTS[i])] = i;
    }
    return map;
})();

// Single-segment / per-segment capacities.
const GSM7_SINGLE_MAX = 160;          // septets
const GSM7_MULTI_MAX = 153;           // septets, leaves room for 6-octet UDH (7 septets + 1 fill bit)
const UCS2_SINGLE_MAX_BYTES = 140;    // 70 UCS2 chars
const UCS2_MULTI_MAX_BYTES = 134;     // leaves room for the 6-octet UDH

function toHex(byteOrBytes) {
    if (Array.isArray(byteOrBytes)) {
        return byteOrBytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join("");
    }
    return byteOrBytes.toString(16).toUpperCase().padStart(2, "0");
}

/**
 * Encode text into GSM 7-bit "units" (each unit is 1 septet, or 2 for an
 * escaped extension char). Returns null if any char is outside the alphabet,
 * signalling that UCS2 must be used instead.
 */
function gsm7Units(text) {
    const units = [];
    for (const ch of text) {
        if (Object.prototype.hasOwnProperty.call(GSM7_BASIC, ch)) {
            units.push([GSM7_BASIC[ch]]);
        } else if (Object.prototype.hasOwnProperty.call(GSM7_EXT, ch)) {
            units.push([0x1B, GSM7_EXT[ch]]);
        } else {
            return null;
        }
    }
    return units;
}

/** Pack 7-bit septets into octets, optionally offset by `fillBits` (for UDH alignment). */
function pack7bit(septets, fillBits) {
    const octets = [];
    let buffer = 0;
    let bits = fillBits || 0;
    for (let i = 0; i < septets.length; i++) {
        buffer |= (septets[i] << bits);
        bits += 7;
        while (bits >= 8) {
            octets.push(buffer & 0xFF);
            buffer >>>= 8;
            bits -= 8;
        }
    }
    if (bits > 0) {
        octets.push(buffer & 0xFF);
    }
    return octets;
}

/** Encode the originating address (TP-OA) -> hex string (length + type + digits). */
function encodeOA(sender) {
    let addr = String(sender || "").trim();
    let toa;
    let valueHex;
    let length;
    const intl = addr.startsWith("+");
    if (intl) addr = addr.slice(1);

    if (/^[0-9]+$/.test(addr)) {
        // Numeric address. International if it had a leading '+', otherwise national.
        toa = intl ? 0x91 : 0x81;
        length = addr.length;
        let digits = addr;
        if (digits.length % 2) digits += "F";
        valueHex = "";
        for (let i = 0; i < digits.length; i += 2) {
            valueHex += digits[i + 1] + digits[i];
        }
    } else {
        // Alphanumeric sender id (best effort): GSM7-packed, TON = alphanumeric.
        toa = 0xD0;
        const units = gsm7Units(addr) || gsm7Units(addr.replace(/[^\x00-\x7F]/g, "?"));
        const septets = [].concat.apply([], units);
        const octets = pack7bit(septets, 0);
        length = octets.length * 2; // address-length is counted in semi-octets
        valueHex = toHex(octets);
    }
    return toHex(length) + toHex(toa) + valueHex;
}

/** Encode the service-centre timestamp (TP-SCTS, 7 octets) in UTC. */
function encodeSCTS(date) {
    function semi(n) {
        const v = ((n % 100) + 100) % 100;
        const tens = Math.floor(v / 10);
        const units = v % 10;
        return (units << 4) | tens;
    }
    return toHex([
        semi(date.getUTCFullYear()),
        semi(date.getUTCMonth() + 1),
        semi(date.getUTCDate()),
        semi(date.getUTCHours()),
        semi(date.getUTCMinutes()),
        semi(date.getUTCSeconds()),
        0x00 // timezone: UTC (+0)
    ]);
}

function udhConcat(ref, total, seq) {
    // UDHL=05, IEI=00 (concat 8-bit ref), IEDL=03, ref, total, seq
    return [0x05, 0x00, 0x03, ref & 0xFF, total & 0xFF, seq & 0xFF];
}

/** Split GSM7 units into segments without breaking an escape pair. */
function splitGsm7(units, maxSeptets) {
    const segments = [];
    let current = [];
    let count = 0;
    for (const unit of units) {
        if (count + unit.length > maxSeptets) {
            segments.push(current);
            current = [];
            count = 0;
        }
        current.push(unit);
        count += unit.length;
    }
    if (current.length || segments.length === 0) segments.push(current);
    return segments;
}

/** Split text into UCS2 segments by code point (never splits a surrogate pair). */
function splitUcs2(text, maxBytes) {
    const segments = [];
    let current = "";
    let bytes = 0;
    for (const ch of text) {
        const chBytes = ch.length * 2; // surrogate pair -> 2 UTF-16 units -> 4 bytes
        if (bytes + chBytes > maxBytes) {
            segments.push(current);
            current = "";
            bytes = 0;
        }
        current += ch;
        bytes += chBytes;
    }
    if (current.length || segments.length === 0) segments.push(current);
    return segments;
}

function ucs2Bytes(text) {
    const buf = Buffer.from(text, "utf16le").swap16();
    return Array.from(buf);
}

/**
 * Assemble one SMS-DELIVER PDU.
 * @param {string} oaHex   encoded originating address
 * @param {string} sctsHex encoded timestamp
 * @param {number} dcs     0x00 (GSM7) or 0x08 (UCS2)
 * @param {number} udl     TP-User-Data-Length (septets for GSM7, octets for UCS2)
 * @param {number[]} ud    user-data octets (UDH + payload)
 * @param {boolean} hasUdh whether a UDH is present (sets the UDHI bit)
 */
function assemblePdu(oaHex, sctsHex, dcs, udl, ud, hasUdh) {
    const smsc = "00";
    const firstOctet = hasUdh ? 0x40 : 0x00; // SMS-DELIVER (MTI=0), UDHI when concatenated
    const pid = "00";
    return (
        smsc +
        toHex(firstOctet) +
        oaHex +
        pid +
        toHex(dcs) +
        sctsHex +
        toHex(udl) +
        toHex(ud)
    );
}

/**
 * Build the SMS-DELIVER PDU(s) for an inbound message.
 * @param {string} sender originating phone number (e.g. "+972508585850")
 * @param {string} text   message body
 * @param {Date}   date   timestamp (defaults to now)
 * @returns {string[]} one hex PDU per segment
 */
function buildDeliverPdus(sender, text, date) {
    const when = date || new Date();
    const oaHex = encodeOA(sender);
    const sctsHex = encodeSCTS(when);
    const body = text != null ? String(text) : "";

    const units = gsm7Units(body);
    const pdus = [];

    if (units) {
        // GSM 7-bit
        const totalSeptets = units.reduce((n, u) => n + u.length, 0);
        if (totalSeptets <= GSM7_SINGLE_MAX) {
            const septets = [].concat.apply([], units);
            const ud = pack7bit(septets, 0);
            pdus.push(assemblePdu(oaHex, sctsHex, 0x00, septets.length, ud, false));
        } else {
            const segments = splitGsm7(units, GSM7_MULTI_MAX);
            const ref = Math.floor(Math.random() * 256);
            segments.forEach((segUnits, idx) => {
                const septets = [].concat.apply([], segUnits);
                const udh = udhConcat(ref, segments.length, idx + 1);
                const ud = udh.concat(pack7bit(septets, 1)); // 1 fill bit aligns text to a septet boundary
                const udl = 7 + septets.length;              // 6-octet UDH == 7 septets
                pdus.push(assemblePdu(oaHex, sctsHex, 0x00, udl, ud, true));
            });
        }
    } else {
        // UCS2
        const bytes = ucs2Bytes(body);
        if (bytes.length <= UCS2_SINGLE_MAX_BYTES) {
            pdus.push(assemblePdu(oaHex, sctsHex, 0x08, bytes.length, bytes, false));
        } else {
            const segments = splitUcs2(body, UCS2_MULTI_MAX_BYTES);
            const ref = Math.floor(Math.random() * 256);
            segments.forEach((segText, idx) => {
                const segBytes = ucs2Bytes(segText);
                const udh = udhConcat(ref, segments.length, idx + 1);
                const ud = udh.concat(segBytes);
                const udl = udh.length + segBytes.length;
                pdus.push(assemblePdu(oaHex, sctsHex, 0x08, udl, ud, true));
            });
        }
    }
    return pdus;
}

module.exports = {
    buildDeliverPdus,
    // exported for testing
    encodeOA,
    pack7bit,
    gsm7Units
};
