/* Browser port of enhanced_v1/obmd_v1.py.
 * Only mvhd.duration is changed to the ISO unknown-duration sentinel.
 * Encoded video/audio and per-track timing remain untouched.
 */
(() => {
    "use strict";

    const UINT32_MAX = 0xffffffff;
    const CONTAINERS = new Set(["moov", "trak", "edts", "mdia", "minf", "stbl"]);

    function allocate(size) {
        if (!Number.isSafeInteger(size) || size < 0) throw new Error("The MP4 size exceeds JavaScript's supported range.");
        try { return new Uint8Array(size); }
        catch (error) {
            if (error instanceof RangeError) throw new Error("Chrome could not allocate enough memory for this file. Close other tabs and try again.");
            throw error;
        }
    }
    function asBytes(input) {
        if (input instanceof Uint8Array) return input;
        if (input instanceof ArrayBuffer) return new Uint8Array(input);
        throw new Error("Expected an MP4 file buffer.");
    }
    function view(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
    function u32(bytes, offset = 0) {
        if (offset < 0 || offset + 4 > bytes.length) throw new Error("Truncated MP4 field.");
        return view(bytes).getUint32(offset, false);
    }
    function u64(bytes, offset = 0) {
        const value = u32(bytes, offset) * 4294967296 + u32(bytes, offset + 4);
        if (!Number.isSafeInteger(value)) throw new Error("MP4 offset exceeds JavaScript's supported range.");
        return value;
    }
    function put32(bytes, offset, value) {
        if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) throw new Error("MP4 field exceeds the 32-bit limit.");
        view(bytes).setUint32(offset, value, false);
    }
    function put64(bytes, offset, value) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("MP4 offset exceeds JavaScript's supported range.");
        put32(bytes, offset, Math.floor(value / 4294967296));
        put32(bytes, offset + 4, value % 4294967296);
    }
    function fourcc(bytes, offset) {
        if (offset < 0 || offset + 4 > bytes.length) throw new Error("Truncated MP4 box type.");
        return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    }
    function putText(bytes, offset, text) {
        for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
    }
    function checked(value) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("The MP4 size exceeds JavaScript's supported range.");
        return value;
    }

    function parseTop(bytes) {
        const boxes = [];
        for (let pos = 0; pos < bytes.length;) {
            if (pos + 8 > bytes.length) break;
            let size = u32(bytes, pos), header = 8;
            const kind = fourcc(bytes, pos + 4);
            if (size === 1) {
                if (pos + 16 > bytes.length) throw new Error("Truncated extended MP4 header.");
                size = u64(bytes, pos + 8); header = 16;
            } else if (size === 0) size = bytes.length - pos;
            if (size < header || pos + size > bytes.length) throw new Error(`Malformed top-level ${kind} box.`);
            boxes.push({ kind, start: pos, size, header });
            pos += size;
        }
        return boxes;
    }
    function parseBoxes(bytes, start, end, depth = 0) {
        if (depth > 32) throw new Error("MP4 boxes are nested too deeply.");
        const boxes = [];
        for (let pos = start; pos < end;) {
            if (pos + 8 > end) break;
            let size = u32(bytes, pos), header = 8;
            const kind = fourcc(bytes, pos + 4);
            if (size === 1) {
                if (pos + 16 > end) break;
                size = u64(bytes, pos + 8); header = 16;
            } else if (size === 0) size = end - pos;
            if (size < header || pos + size > end) break;
            const container = CONTAINERS.has(kind);
            boxes.push({
                kind,
                children: container ? parseBoxes(bytes, pos + header, pos + size, depth + 1) : null,
                payload: container ? null : bytes.subarray(pos + header, pos + size)
            });
            pos += size;
        }
        return boxes;
    }
    function boxBodySize(box) {
        return box.children === null ? box.payload.length : box.children.reduce((sum, child) => checked(sum + boxSize(child)), 0);
    }
    function boxSize(box) {
        const size = checked(boxBodySize(box) + 8);
        if (size > UINT32_MAX) throw new Error("The MP4 index is too large for the browser patcher.");
        return size;
    }
    function writeBox(box, output, offset) {
        const size = boxSize(box);
        put32(output, offset, size); putText(output, offset + 4, box.kind);
        let cursor = offset + 8;
        if (box.children === null) {
            output.set(box.payload, cursor);
            return cursor + box.payload.length;
        }
        for (const child of box.children) cursor = writeBox(child, output, cursor);
        return cursor;
    }
    function buildBoxes(boxes) {
        const size = boxes.reduce((sum, box) => checked(sum + boxSize(box)), 0);
        const output = allocate(size);
        let cursor = 0;
        for (const box of boxes) cursor = writeBox(box, output, cursor);
        return output;
    }
    function findPath(boxes, path) {
        if (!path.length) return null;
        for (const box of boxes) {
            if (box.kind !== path[0]) continue;
            if (path.length === 1) return box;
            if (box.children !== null) {
                const found = findPath(box.children, path.slice(1));
                if (found) return found;
            }
        }
        return null;
    }
    function* walk(boxes) {
        for (const box of boxes) {
            yield box;
            if (box.children !== null) yield* walk(box.children);
        }
    }

    function setDurationUnknown(data) {
        if (data.length < 4) throw new Error("Movie header is too short.");
        if (data[0] === 1) {
            if (data.length < 112) throw new Error("Version-1 movie header is too short.");
            const output = data.slice();
            output.fill(0xff, 24, 32);
            return output;
        }
        if (data[0] !== 0) throw new Error(`Unsupported movie-header version ${data[0]}.`);
        if (data.length < 100) throw new Error("Version-0 movie header is too short.");
        const output = allocate(112);
        output[0] = 1;
        output.set(data.subarray(1, 4), 1);
        output.set(data.subarray(4, 8), 8);
        output.set(data.subarray(8, 12), 16);
        output.set(data.subarray(12, 16), 20);
        output.fill(0xff, 24, 32);
        output.set(data.subarray(20, 100), 32);
        return output;
    }
    function snapshotOffsets(moovBoxes) {
        const snapshots = [];
        for (const box of walk(moovBoxes)) {
            if (box.kind !== "stco" && box.kind !== "co64") continue;
            const width = box.kind === "co64" ? 8 : 4;
            if (box.payload.length < 8) throw new Error(`${box.kind} table is too short.`);
            const count = u32(box.payload, 4);
            if (8 + count * width > box.payload.length) throw new Error(`${box.kind} table is malformed.`);
            const offsets = [];
            for (let i = 0; i < count; i++) offsets.push(width === 8 ? u64(box.payload, 8 + i * width) : u32(box.payload, 8 + i * width));
            snapshots.push({ box, originalKind: box.kind, offsets });
        }
        return snapshots;
    }
    function applyShift(snapshots, shift) {
        for (const snapshot of snapshots) {
            const offsets = snapshot.offsets.map(offset => checked(offset + shift));
            const is64 = snapshot.originalKind === "co64" || offsets.some(offset => offset > UINT32_MAX);
            snapshot.box.kind = is64 ? "co64" : "stco";
            const width = is64 ? 8 : 4;
            const payload = allocate(8 + offsets.length * width);
            put32(payload, 4, offsets.length);
            offsets.forEach((offset, index) => is64 ? put64(payload, 8 + index * 8, offset) : put32(payload, 8 + index * 4, offset));
            snapshot.box.payload = payload;
        }
    }

    function findVideoTrack(moovBoxes) {
        for (const track of moovBoxes.filter(box => box.kind === "trak")) {
            const hdlr = findPath(track.children || [], ["mdia", "hdlr"]);
            if (!hdlr?.payload || hdlr.payload.length < 12 || fourcc(hdlr.payload, 8) !== "vide") continue;
            return track;
        }
        throw new Error("No video track was found in this MP4.");
    }
    function findVideoInfo(moovBoxes, fileSize) {
            const track = findVideoTrack(moovBoxes);
            const mdhd = findPath(track.children, ["mdia", "mdhd"]);
            const stbl = findPath(track.children, ["mdia", "minf", "stbl"]);
            const stsd = findPath(stbl?.children || [], ["stsd"]);
            const stts = findPath(stbl?.children || [], ["stts"]);
            const tkhd = findPath(track.children, ["tkhd"]);
            if (!mdhd || !stsd || !stts) throw new Error("Video metadata tables are incomplete.");
            const mdhdOffset = mdhd.payload[0] === 1 ? 20 : 12;
            const scale = u32(mdhd.payload, mdhdOffset);
            if (!scale) throw new Error("Video timing scale is invalid.");
            const timingCount = u32(stts.payload, 4);
            let samples = 0, ticks = 0;
            for (let i = 0; i < timingCount; i++) {
                const count = u32(stts.payload, 8 + i * 8), delta = u32(stts.payload, 12 + i * 8);
                samples += count; ticks += count * delta;
            }
            const dimensionOffset = tkhd?.payload?.[0] === 1 ? 88 : 76;
            let width = tkhd?.payload?.length >= dimensionOffset + 8 ? u32(tkhd.payload, dimensionOffset) / 65536 : 0;
            let height = tkhd?.payload?.length >= dimensionOffset + 8 ? u32(tkhd.payload, dimensionOffset + 4) / 65536 : 0;
            if ((!width || !height) && stsd.payload.length >= 44) {
                width = view(stsd.payload).getUint16(40, false); height = view(stsd.payload).getUint16(42, false);
            }
            const duration = ticks / scale;
            return {
                width, height, duration,
                fps: duration > 0 ? samples / duration : 0,
                bitrateBps: duration > 0 ? fileSize * 8 / duration : 0,
                codec: stsd.payload.length >= 16 ? fourcc(stsd.payload, 12) : "MP4",
                realSamples: samples
            };
    }
    function readInput(input) {
        const bytes = asBytes(input), top = parseTop(bytes);
        const moovs = top.filter(box => box.kind === "moov"), mdats = top.filter(box => box.kind === "mdat");
        if (!moovs.length || !mdats.length) throw new Error("The MP4 is missing its movie index or media section.");
        const moov = moovs[0], mdat = mdats[0];
        const moovBoxes = parseBoxes(bytes, moov.start + moov.header, moov.start + moov.size);
        if (!moovBoxes.length) throw new Error("The MP4 movie index is empty or malformed.");
        return { bytes, top, moov, mdat, moovBoxes };
    }

    function inspect(input) {
        const state = readInput(input);
        return findVideoInfo(state.moovBoxes, state.bytes.length);
    }
    function patch(input) {
        const state = readInput(input);
        const sourceInfo = findVideoInfo(state.moovBoxes, state.bytes.length);
        const mvhd = findPath(state.moovBoxes, ["mvhd"]);
        if (!mvhd?.payload) throw new Error("The MP4 has no movie header.");
        const sourceVersion = mvhd.payload[0];
        mvhd.payload = setDurationUnknown(mvhd.payload);
        const oldMoovBodySize = state.moov.size - state.moov.header;
        let newMoovBody = buildBoxes(state.moovBoxes);
        let shift = state.moov.start < state.mdat.start ? newMoovBody.length - oldMoovBodySize : 0;
        if (shift) {
            const snapshots = snapshotOffsets(state.moovBoxes);
            applyShift(snapshots, shift);
            newMoovBody = buildBoxes(state.moovBoxes);
            const shift2 = newMoovBody.length - oldMoovBodySize;
            if (shift2 !== shift) {
                applyShift(snapshots, shift2);
                newMoovBody = buildBoxes(state.moovBoxes);
                const shift3 = newMoovBody.length - oldMoovBodySize;
                if (shift3 !== shift2) throw new Error("Chunk offsets did not stabilize.");
                shift = shift3;
            } else shift = shift2;
        }
        const newMoov = allocate(newMoovBody.length + 8);
        put32(newMoov, 0, newMoov.length); putText(newMoov, 4, "moov"); newMoov.set(newMoovBody, 8);
        const outputSize = state.top.reduce((sum, box) => checked(sum + (box === state.moov ? newMoov.length : box.size)), 0);
        const output = allocate(outputSize);
        let cursor = 0;
        for (const box of state.top) {
            const part = box === state.moov ? newMoov : state.bytes.subarray(box.start, box.start + box.size);
            output.set(part, cursor); cursor += part.length;
        }
        return {
            output,
            info: {
                method: "enhanced_obmd_source_quality", source_mvhd_version: sourceVersion,
                output_mvhd_version: 1, duration_unknown: true,
                source_dimensions: { width: sourceInfo.width, height: sourceInfo.height },
                output_dimensions: { width: sourceInfo.width, height: sourceInfo.height },
                codec: sourceInfo.codec,
                moov_growth: newMoov.length - state.moov.size,
                chunk_offset_shift: shift
            }
        };
    }

    globalThis.WtmMp4Patcher = Object.freeze({ inspect, patch });
})();
