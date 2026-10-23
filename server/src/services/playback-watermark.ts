/**
 * V4 dynamic partial-identity watermark payload generator.
 *
 * Produces a watermark descriptor carrying only a PSEUDONYMOUS partial
 * identity (never a full phone number or full email address) plus a
 * randomized layout (position, opacity, overlap) so a leaked frame cannot be
 * traced to a stable on-screen location. Screenshots are never claimed to be
 * impossible — the payload explicitly states that capture remains possible.
 *
 * Pure and deterministic given an injected RNG; no network, no DB.
 */
export interface PartialIdentity {
    /** Truncated/partial student identifier (never the full id). */
    studentRef: string;
    /** First name or initial only; never a full legal name. */
    namePartial: string | null;
    /** Last 4 digits of the phone, or null when no phone. */
    phoneLast4: string | null;
    /** Email domain only, or null. */
    emailDomain: string | null;
    /** Truncated tenant reference. */
    tenantRef: string | null;
    /** Group/branch label, already non-PII. */
    groupLabel: string | null;
}

export interface WatermarkLayer {
    text: string;
    x: number;
    y: number;
    opacity: number;
    rotation: number;
    fontSize: number;
}

export interface WatermarkBounds {
    /** Inclusive lower/upper bounds for opacity (0..1). */
    opacityMin: number;
    opacityMax: number;
    /** Number of overlapping layers. */
    minLayers: number;
    maxLayers: number;
    /** Position bounds as fractions of the viewport (0..1). */
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
}

export const DEFAULT_WATERMARK_BOUNDS: WatermarkBounds = {
    opacityMin: 0.08,
    opacityMax: 0.32,
    minLayers: 2,
    maxLayers: 4,
    xMin: 0.05,
    xMax: 0.95,
    yMin: 0.05,
    yMax: 0.95,
};

export interface WatermarkInput {
    studentId: string;
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    tenantId?: string | null;
    groupLabel?: string | null;
    sessionId?: string | null;
    forensicCode?: string | null;
}

export interface WatermarkPayload {
    /** Pseudonymous partial identity only. */
    partialIdentity: PartialIdentity;
    /** Randomized on-screen layers. */
    layers: WatermarkLayer[];
    /** Randomized primary position (fraction of viewport). */
    position: { x: number; y: number };
    /** Randomized primary opacity. */
    opacity: number;
    /** Randomized overlap count. */
    overlap: number;
    /** Seed used for the layout (not the identity). */
    layoutSeed: string;
    /** Explicit statement: screenshots are NOT claimed impossible. */
    screenshotsPossible: true;
    screenshotProtectionClaim: false;
    disclaimer: string;
    generatedAt: string;
}

export type Rng = () => number;

function clamp(value: number, min: number, max: number): number {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

function round(value: number, digits = 4): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

/** Truncate an id to its last N characters, never the full value. */
function partialId(value: string | null | undefined, keep = 6): string {
    if (!value) return 'unknown';
    const trimmed = String(value).trim();
    if (!trimmed) return 'unknown';
    // Reveal at most half, and never the whole value: a 1-character id used to
    // be returned in full, and an 8-character id revealed 4 of them.
    const reveal = Math.max(1, Math.min(keep, Math.floor(trimmed.length / 2)));
    if (trimmed.length <= reveal) return `…${trimmed.slice(-reveal)}`;
    return `…${trimmed.slice(-reveal)}`;
}

/**
 * Pseudonymise the forensic code like every other identifier.
 *
 * The code is a leak-attribution handle, so it must not appear verbatim: a
 * short code was previously embedded in full in every watermark layer. A
 * non-string value is refused rather than throwing on `.slice`.
 */
function pseudonymizeForensicCode(code: unknown): string | null {
    if (typeof code !== 'string') return null;
    const trimmed = code.trim();
    if (!trimmed) return null;
    return partialId(trimmed, 4);
}

function pseudonymizeName(name: string | null | undefined): string | null {
    if (!name) return null;
    const trimmed = String(name).trim();
    if (!trimmed) return null;
    const parts = trimmed.split(/\s+/);
    if (parts.length === 1) return `${parts[0].slice(0, 1)}.`;
    return `${parts[0]} ${parts[parts.length - 1].slice(0, 1)}.`;
}

function phoneLast4(phone: string | null | undefined): string | null {
    if (!phone) return null;
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length < 4) return null;
    return digits.slice(-4);
}

function emailDomain(email: string | null | undefined): string | null {
    if (!email) return null;
    const at = String(email).lastIndexOf('@');
    if (at < 0 || at === String(email).length - 1) return null;
    return String(email).slice(at + 1).toLowerCase();
}

export function pseudonymizeIdentity(input: WatermarkInput): PartialIdentity {
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
export const maskIdentity = pseudonymizeIdentity;
export const partialIdentity = pseudonymizeIdentity;

function defaultRng(): Rng {
    return Math.random;
}

function randBetween(rng: Rng, min: number, max: number): number {
    return min + (max - min) * rng();
}

function pickLayerText(identity: PartialIdentity, input: WatermarkInput): string {
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
    ].filter((v): v is string => Boolean(v));
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
function mergeBounds(partial: Partial<WatermarkBounds> | undefined): WatermarkBounds {
    const merged: WatermarkBounds = { ...DEFAULT_WATERMARK_BOUNDS, ...(partial ?? {}) };
    const d = DEFAULT_WATERMARK_BOUNDS;
    const pair = (min: number, max: number, dMin: number, dMax: number): [number, number] => {
        if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return [dMin, dMax];
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

export function generateWatermarkPayload(
    input: WatermarkInput,
    options: {
        bounds?: Partial<WatermarkBounds>;
        rng?: Rng;
        now?: () => Date;
        layerCount?: number;
    } = {},
): WatermarkPayload {
    const bounds = mergeBounds(options.bounds);
    const rng = options.rng ?? defaultRng();
    const now = options.now ?? (() => new Date());
    const identity = pseudonymizeIdentity(input);

    const overlap = clamp(
        options.layerCount ?? Math.round(randBetween(rng, bounds.minLayers, bounds.maxLayers)),
        bounds.minLayers,
        bounds.maxLayers,
    );

    const position = {
        x: round(clamp(randBetween(rng, bounds.xMin, bounds.xMax), bounds.xMin, bounds.xMax)),
        y: round(clamp(randBetween(rng, bounds.yMin, bounds.yMax), bounds.yMin, bounds.yMax)),
    };

    const opacity = round(clamp(randBetween(rng, bounds.opacityMin, bounds.opacityMax), bounds.opacityMin, bounds.opacityMax), 3);

    const layers: WatermarkLayer[] = [];
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
        disclaimer:
            'Watermarking raises the cost of leakage but cannot make screenshots or external capture impossible.',
        generatedAt: now().toISOString(),
    };
}

export const createWatermarkPayload = generateWatermarkPayload;
export const buildWatermarkPayload = generateWatermarkPayload;
export const generateDynamicWatermark = generateWatermarkPayload;
export const createDynamicWatermark = generateWatermarkPayload;

/** Backwards-friendly single-call helper used by routes. */
export function buildWatermark(input: WatermarkInput, options?: Parameters<typeof generateWatermarkPayload>[1]): WatermarkPayload {
    return generateWatermarkPayload(input, options);
}
