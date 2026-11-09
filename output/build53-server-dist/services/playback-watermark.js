"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDynamicWatermark = exports.generateDynamicWatermark = exports.buildWatermarkPayload = exports.createWatermarkPayload = exports.partialIdentity = exports.maskIdentity = exports.DEFAULT_WATERMARK_BOUNDS = void 0;
exports.pseudonymizeIdentity = pseudonymizeIdentity;
exports.generateWatermarkPayload = generateWatermarkPayload;
exports.buildWatermark = buildWatermark;
exports.DEFAULT_WATERMARK_BOUNDS = {
    opacityMin: 0.08,
    opacityMax: 0.32,
    minLayers: 2,
    maxLayers: 4,
    xMin: 0.05,
    xMax: 0.95,
    yMin: 0.05,
    yMax: 0.95,
};
function clamp(value, min, max) {
    if (value < min)
        return min;
    if (value > max)
        return max;
    return value;
}
function round(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
/** Truncate an id to its last N characters, never the full value. */
function partialId(value, keep = 6) {
    if (!value)
        return 'unknown';
    const trimmed = String(value).trim();
    if (!trimmed)
        return 'unknown';
    // Reveal at most half, and never the whole value: a 1-character id used to
    // be returned in full, and an 8-character id revealed 4 of them.
    const reveal = Math.max(1, Math.min(keep, Math.floor(trimmed.length / 2)));
    if (trimmed.length <= reveal)
        return `…${trimmed.slice(-reveal)}`;
    return `…${trimmed.slice(-reveal)}`;
}
/**
 * Pseudonymise the forensic code like every other identifier.
 *
 * The code is a leak-attribution handle, so it must not appear verbatim: a
 * short code was previously embedded in full in every watermark layer. A
 * non-string value is refused rather than throwing on `.slice`.
 */
function pseudonymizeForensicCode(code) {
    if (typeof code !== 'string')
        return null;
    const trimmed = code.trim();
    if (!trimmed)
        return null;
    return partialId(trimmed, 4);
}
function pseudonymizeName(name) {
    if (!name)
        return null;
    const trimmed = String(name).trim();
    if (!trimmed)
        return null;
    const parts = trimmed.split(/\s+/);
    if (parts.length === 1)
        return `${parts[0].slice(0, 1)}.`;
    return `${parts[0]} ${parts[parts.length - 1].slice(0, 1)}.`;
}
function phoneLast4(phone) {
    if (!phone)
        return null;
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length < 4)
        return null;
    return digits.slice(-4);
}
function emailDomain(email) {
    if (!email)
        return null;
    const at = String(email).lastIndexOf('@');
    if (at < 0 || at === String(email).length - 1)
        return null;
    return String(email).slice(at + 1).toLowerCase();
}
function pseudonymizeIdentity(input) {
    return {
        studentRef: partialId(input.studentId, 6),
        namePartial: pseudonymizeName(input.name),
        phoneLast4: phoneLast4(input.phone),
        emailDomain: emailDomain(input.email),
        tenantRef: input.tenantId ? partialId(input.tenantId, 4) : null,
        groupLabel: input.groupLabel ? String(input.groupLabel).slice(0, 32) : null,
    };
}
/** Alias used by some callers. */
exports.maskIdentity = pseudonymizeIdentity;
exports.partialIdentity = pseudonymizeIdentity;
function defaultRng() {
    return Math.random;
}
function randBetween(rng, min, max) {
    return min + (max - min) * rng();
}
function pickLayerText(identity, input) {
    const bits = [
        identity.studentRef,
        identity.phoneLast4 ? `…${identity.phoneLast4}` : null,
        identity.emailDomain ? `@${identity.emailDomain}` : null,
        // The forensic code is the one field that used to skip pseudonymisation
        // entirely: a code of ≤16 characters appeared in full in every layer,
        // and a longer one leaked its stable prefix. It is now truncated the
        // same way as every other identifier, and a non-string value is refused
        // rather than throwing on `.slice`.
        pseudonymizeForensicCode(input.forensicCode),
        input.sessionId ? partialId(String(input.sessionId), 4) : null,
    ].filter((v) => Boolean(v));
    return bits.join(' • ');
}
/**
 * Merge partial bounds over the defaults WITHOUT letting a single override
 * invert the range.
 *
 * `{ opacityMin: 0.5 }` alone used to leave `opacityMax` at its default, so
 * `randBetween` produced an inverted range and `clamp` pinned opacity to a
 * constant; `{ minLayers: 5 }` alone yielded 5 layers despite `maxLayers: 4`.
 * Every pair is therefore re-paired after the merge, and an override that
 * cannot be honoured without crossing its partner is clamped to the default
 * rather than silently degrading the layout.
 */
function mergeBounds(partial) {
    const merged = { ...exports.DEFAULT_WATERMARK_BOUNDS, ...(partial ?? {}) };
    const d = exports.DEFAULT_WATERMARK_BOUNDS;
    const pair = (min, max, dMin, dMax) => {
        if (!Number.isFinite(min) || !Number.isFinite(max) || min > max)
            return [dMin, dMax];
        return [min, max];
    };
    [merged.xMin, merged.xMax] = pair(merged.xMin, merged.xMax, d.xMin, d.xMax);
    [merged.yMin, merged.yMax] = pair(merged.yMin, merged.yMax, d.yMin, d.yMax);
    [merged.opacityMin, merged.opacityMax] = pair(merged.opacityMin, merged.opacityMax, d.opacityMin, d.opacityMax);
    [merged.minLayers, merged.maxLayers] = pair(merged.minLayers, merged.maxLayers, d.minLayers, d.maxLayers);
    merged.minLayers = Math.max(1, Math.trunc(merged.minLayers));
    merged.maxLayers = Math.max(merged.minLayers, Math.trunc(merged.maxLayers));
    return merged;
}
function generateWatermarkPayload(input, options = {}) {
    const bounds = mergeBounds(options.bounds);
    const rng = options.rng ?? defaultRng();
    const now = options.now ?? (() => new Date());
    const identity = pseudonymizeIdentity(input);
    const overlap = clamp(options.layerCount ?? Math.round(randBetween(rng, bounds.minLayers, bounds.maxLayers)), bounds.minLayers, bounds.maxLayers);
    const position = {
        x: round(clamp(randBetween(rng, bounds.xMin, bounds.xMax), bounds.xMin, bounds.xMax)),
        y: round(clamp(randBetween(rng, bounds.yMin, bounds.yMax), bounds.yMin, bounds.yMax)),
    };
    const opacity = round(clamp(randBetween(rng, bounds.opacityMin, bounds.opacityMax), bounds.opacityMin, bounds.opacityMax), 3);
    const layers = [];
    const text = pickLayerText(identity, input);
    for (let i = 0; i < overlap; i += 1) {
        layers.push({
            text,
            x: round(clamp(randBetween(rng, bounds.xMin, bounds.xMax), bounds.xMin, bounds.xMax)),
            y: round(clamp(randBetween(rng, bounds.yMin, bounds.yMax), bounds.yMin, bounds.yMax)),
            opacity: round(clamp(randBetween(rng, bounds.opacityMin, bounds.opacityMax), bounds.opacityMin, bounds.opacityMax), 3),
            rotation: round(randBetween(rng, -18, 18), 2),
            fontSize: Math.round(randBetween(rng, 12, 18)),
        });
    }
    const layoutSeed = `${Math.floor(rng() * 1e9).toString(36)}-${now().getTime().toString(36)}`;
    return {
        partialIdentity: identity,
        layers,
        position,
        opacity,
        overlap,
        layoutSeed,
        screenshotsPossible: true,
        screenshotProtectionClaim: false,
        disclaimer: 'Watermarking raises the cost of leakage but cannot make screenshots or external capture impossible.',
        generatedAt: now().toISOString(),
    };
}
exports.createWatermarkPayload = generateWatermarkPayload;
exports.buildWatermarkPayload = generateWatermarkPayload;
exports.generateDynamicWatermark = generateWatermarkPayload;
exports.createDynamicWatermark = generateWatermarkPayload;
/** Backwards-friendly single-call helper used by routes. */
function buildWatermark(input, options) {
    return generateWatermarkPayload(input, options);
}
