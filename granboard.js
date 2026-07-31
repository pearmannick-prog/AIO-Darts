// granboard.js
//
// Web Bluetooth connection + protocol decoding for the Granboard dartboard.
//
// The GRANBOARD_UUID and SEGMENT_MAPPING table below are adapted from the
// open-source project sobassy/gran-app (MIT License, Copyright (c) 2024
// Sobassy): https://github.com/sobassy/gran-app
//
// That project figured out, by sniffing the board's Bluetooth traffic, that
// every dart hit fires a Bluetooth "notify" event on a single characteristic,
// and the raw bytes received always decode as a short ASCII-ish numeric
// string unique to that exact segment. This file re-implements that same
// mapping as plain JS (no React/Next.js needed) so it can run as a static
// page with no build step.

export const GRANBOARD_SERVICE_UUID = "442f1570-8a00-9a28-cbe1-e1d4212d53eb";

export const SegmentID = Object.freeze({
  INNER_1: 0, TRP_1: 1, OUTER_1: 2, DBL_1: 3,
  INNER_2: 4, TRP_2: 5, OUTER_2: 6, DBL_2: 7,
  INNER_3: 8, TRP_3: 9, OUTER_3: 10, DBL_3: 11,
  INNER_4: 12, TRP_4: 13, OUTER_4: 14, DBL_4: 15,
  INNER_5: 16, TRP_5: 17, OUTER_5: 18, DBL_5: 19,
  INNER_6: 20, TRP_6: 21, OUTER_6: 22, DBL_6: 23,
  INNER_7: 24, TRP_7: 25, OUTER_7: 26, DBL_7: 27,
  INNER_8: 28, TRP_8: 29, OUTER_8: 30, DBL_8: 31,
  INNER_9: 32, TRP_9: 33, OUTER_9: 34, DBL_9: 35,
  INNER_10: 36, TRP_10: 37, OUTER_10: 38, DBL_10: 39,
  INNER_11: 40, TRP_11: 41, OUTER_11: 42, DBL_11: 43,
  INNER_12: 44, TRP_12: 45, OUTER_12: 46, DBL_12: 47,
  INNER_13: 48, TRP_13: 49, OUTER_13: 50, DBL_13: 51,
  INNER_14: 52, TRP_14: 53, OUTER_14: 54, DBL_14: 55,
  INNER_15: 56, TRP_15: 57, OUTER_15: 58, DBL_15: 59,
  INNER_16: 60, TRP_16: 61, OUTER_16: 62, DBL_16: 63,
  INNER_17: 64, TRP_17: 65, OUTER_17: 66, DBL_17: 67,
  INNER_18: 68, TRP_18: 69, OUTER_18: 70, DBL_18: 71,
  INNER_19: 72, TRP_19: 73, OUTER_19: 74, DBL_19: 75,
  INNER_20: 76, TRP_20: 77, OUTER_20: 78, DBL_20: 79,
  BULL: 80, DBL_BULL: 81, MISS: 82, BUST: 83, RESET_BUTTON: 84,
});

const SEGMENT_MAPPING = {
  "50-46-51-64": SegmentID.INNER_1, "50-46-52-64": SegmentID.TRP_1, "50-46-53-64": SegmentID.OUTER_1, "50-46-54-64": SegmentID.DBL_1,
  "57-46-49-64": SegmentID.INNER_2, "57-46-48-64": SegmentID.TRP_2, "57-46-50-64": SegmentID.OUTER_2, "56-46-50-64": SegmentID.DBL_2,
  "55-46-49-64": SegmentID.INNER_3, "55-46-48-64": SegmentID.TRP_3, "55-46-50-64": SegmentID.OUTER_3, "56-46-52-64": SegmentID.DBL_3,
  "48-46-49-64": SegmentID.INNER_4, "48-46-51-64": SegmentID.TRP_4, "48-46-53-64": SegmentID.OUTER_4, "48-46-54-64": SegmentID.DBL_4,
  "53-46-49-64": SegmentID.INNER_5, "53-46-50-64": SegmentID.TRP_5, "53-46-52-64": SegmentID.OUTER_5, "52-46-54-64": SegmentID.DBL_5,
  "49-46-48-64": SegmentID.INNER_6, "49-46-49-64": SegmentID.TRP_6, "49-46-51-64": SegmentID.OUTER_6, "52-46-52-64": SegmentID.DBL_6,
  "49-49-46-49-64": SegmentID.INNER_7, "49-49-46-50-64": SegmentID.TRP_7, "49-49-46-52-64": SegmentID.OUTER_7, "56-46-54-64": SegmentID.DBL_7,
  "54-46-50-64": SegmentID.INNER_8, "54-46-52-64": SegmentID.TRP_8, "54-46-53-64": SegmentID.OUTER_8, "54-46-54-64": SegmentID.DBL_8,
  "57-46-51-64": SegmentID.INNER_9, "57-46-52-64": SegmentID.TRP_9, "57-46-53-64": SegmentID.OUTER_9, "57-46-54-64": SegmentID.DBL_9,
  "50-46-48-64": SegmentID.INNER_10, "50-46-49-64": SegmentID.TRP_10, "50-46-50-64": SegmentID.OUTER_10, "52-46-51-64": SegmentID.DBL_10,
  "55-46-51-64": SegmentID.INNER_11, "55-46-52-64": SegmentID.TRP_11, "55-46-53-64": SegmentID.OUTER_11, "55-46-54-64": SegmentID.DBL_11,
  "53-46-48-64": SegmentID.INNER_12, "53-46-51-64": SegmentID.TRP_12, "53-46-53-64": SegmentID.OUTER_12, "53-46-54-64": SegmentID.DBL_12,
  "48-46-48-64": SegmentID.INNER_13, "48-46-50-64": SegmentID.TRP_13, "48-46-52-64": SegmentID.OUTER_13, "52-46-53-64": SegmentID.DBL_13,
  "49-48-46-51-64": SegmentID.INNER_14, "49-48-46-52-64": SegmentID.TRP_14, "49-48-46-53-64": SegmentID.OUTER_14, "49-48-46-54-64": SegmentID.DBL_14,
  "51-46-48-64": SegmentID.INNER_15, "51-46-49-64": SegmentID.TRP_15, "51-46-50-64": SegmentID.OUTER_15, "52-46-50-64": SegmentID.DBL_15,
  "49-49-46-48-64": SegmentID.INNER_16, "49-49-46-51-64": SegmentID.TRP_16, "49-49-46-53-64": SegmentID.OUTER_16, "49-49-46-54-64": SegmentID.DBL_16,
  "49-48-46-49-64": SegmentID.INNER_17, "49-48-46-48-64": SegmentID.TRP_17, "49-48-46-50-64": SegmentID.OUTER_17, "56-46-51-64": SegmentID.DBL_17,
  "49-46-50-64": SegmentID.INNER_18, "49-46-52-64": SegmentID.TRP_18, "49-46-53-64": SegmentID.OUTER_18, "49-46-54-64": SegmentID.DBL_18,
  "54-46-49-64": SegmentID.INNER_19, "54-46-48-64": SegmentID.TRP_19, "54-46-51-64": SegmentID.OUTER_19, "56-46-53-64": SegmentID.DBL_19,
  "51-46-51-64": SegmentID.INNER_20, "51-46-52-64": SegmentID.TRP_20, "51-46-53-64": SegmentID.OUTER_20, "51-46-54-64": SegmentID.DBL_20,
  "56-46-48-64": SegmentID.BULL, "52-46-48-64": SegmentID.DBL_BULL,
  "66-84-78-64": SegmentID.RESET_BUTTON,
};

export const SegmentType = Object.freeze({ Single: 1, Double: 2, Triple: 3, Other: 4 });

function typeLabel(type, shorthand) {
  if (type === SegmentType.Double) return shorthand ? "D" : "Double";
  if (type === SegmentType.Triple) return shorthand ? "T" : "Triple";
  return "";
}

// Turns a raw SegmentID into a full descriptive object: which number wedge,
// single/double/triple, the point value, and display names.
export function createSegment(segmentId) {
  if (segmentId < 80) {
    const typeCycle = [SegmentType.Single, SegmentType.Triple, SegmentType.Single, SegmentType.Double];
    const type = typeCycle[segmentId % 4];
    const section = Math.floor(segmentId / 4) + 1;
    const value = section * type;
    const longName = `${typeLabel(type, false)} ${section}`.trim();
    const shortName = `${typeLabel(type, true)}${section}`;
    return { id: segmentId, type, section, value, longName, shortName, ring: ["inner", "triple", "outer", "double"][segmentId % 4] };
  }

  switch (segmentId) {
    case SegmentID.BULL:
      return { id: segmentId, type: SegmentType.Single, section: "BULL", value: 25, longName: "Bullseye", shortName: "BULL", ring: "bull" };
    case SegmentID.DBL_BULL:
      return { id: segmentId, type: SegmentType.Double, section: "BULL", value: 50, longName: "Double Bullseye", shortName: "DBULL", ring: "dbull" };
    case SegmentID.RESET_BUTTON:
      return { id: segmentId, type: SegmentType.Other, section: "Other", value: 0, longName: "Reset Button", shortName: "RST", ring: "button" };
    case SegmentID.BUST:
      return { id: segmentId, type: SegmentType.Other, section: "Other", value: 0, longName: "Bust", shortName: "Bust", ring: "other" };
    default:
      return { id: segmentId, type: SegmentType.Other, section: "Other", value: 0, longName: "Miss", shortName: "Miss", ring: "other" };
  }
}

// ---------------------------------------------------------------------------
// Bull mode
// ---------------------------------------------------------------------------
// Boards can be scored two ways, and it changes the rules rather than just the
// number:
//
//   split - the standard. Outer bull 25, inner bull 50. Only the inner bull is
//           a double, so only the inner bull can check out a double-out leg.
//   full  - the whole bull counts as 50, i.e. the outer ring is treated as if
//           it were the inner. Because it's then a double 25, the whole bull
//           ALSO becomes a legal double-out finish, and is worth two marks in
//           Cricket rather than one.
//
// Applying it as a segment transform at the input boundary - rather than
// teaching each game about bull modes - means x01, Cricket and Count Up all
// get consistent behaviour with no rules code of their own.
export const BULL_MODES = {
  split: "Split bull (25 / 50)",
  full: "Full bull (50)",
};

export function bullModeLabel(mode) {
  return BULL_MODES[mode] || BULL_MODES.split;
}

export function applyBullMode(segment, bullMode) {
  if (bullMode !== "full") return segment;
  if (segment?.id !== SegmentID.BULL) return segment;
  // Promote the outer bull to the inner bull's scoring, but keep a name that
  // reflects what was actually thrown - calling it "Double Bullseye" in the
  // throw log would misreport the dart.
  return {
    ...createSegment(SegmentID.DBL_BULL),
    id: SegmentID.BULL,
    longName: "Bullseye (full bull, 50)",
    shortName: "BULL",
    ring: "bull",
  };
}

export class Granboard {
  #characteristic;
  segmentHitCallback = null;
  disconnectCallback = null;
  deviceName = "";

  static async connect() {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [GRANBOARD_SERVICE_UUID] }],
    });

    if (!device?.gatt) {
      throw new Error("Could not find a Bluetooth GATT server on that device.");
    }

    if (!device.gatt.connected) {
      await device.gatt.connect();
    }

    const service = await device.gatt.getPrimaryService(GRANBOARD_SERVICE_UUID);
    const characteristics = await service.getCharacteristics();
    const notifyChar = characteristics.find((c) => c.properties.notify);

    if (!notifyChar) {
      throw new Error("Board didn't expose a notify characteristic - is this the right device?");
    }

    const board = new Granboard(notifyChar, device.name || "Granboard");
    await notifyChar.startNotifications();

    device.addEventListener("gattserverdisconnected", () => board.disconnectCallback?.());

    return board;
  }

  constructor(characteristic, deviceName) {
    this.#characteristic = characteristic;
    this.deviceName = deviceName;
    characteristic.addEventListener("characteristicvaluechanged", () => this.#onValueChanged());
  }

  #onValueChanged() {
    const value = this.#characteristic.value;
    if (!value) return;

    const bytes = new Uint8Array(value.buffer);
    const key = bytes.join("-");
    const segmentId = SEGMENT_MAPPING[key];

    if (segmentId !== undefined) {
      this.segmentHitCallback?.(createSegment(segmentId));
    } else {
      console.log(`Unrecognized Granboard signal: [${key}]`);
    }
  }
}
