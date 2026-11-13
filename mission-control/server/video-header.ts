/** Bounded container sniffing, independent of the filename. Codec support is left to the player. */
export function readVideoHeader(bytes: Uint8Array): string | null {
  const text = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
  if (bytes.length >= 16 && text(4, 4) === "ftyp") {
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (boxSize < 16 || boxSize > bytes.length || boxSize % 4 !== 0) return null;
    const brands = [text(8, 4)];
    for (let at = 16; at < boxSize; at += 4) brands.push(text(at, 4));
    if (brands.includes("qt  ")) return "video/quicktime";
    if (brands.some((brand) => /^(isom|iso[2-9]|mp4[12]|avc1|M4V |dash)$/.test(brand))) return "video/mp4";
  }
  // EBML magic and an explicit WebM DocType. Matroska is deliberately excluded.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    for (let at = 4; at + 7 <= bytes.length; at += 1) {
      if (bytes[at] === 0x42 && bytes[at + 1] === 0x82 && bytes[at + 2] === 0x84 && text(at + 3, 4) === "webm") return "video/webm";
    }
  }
  return null;
}
