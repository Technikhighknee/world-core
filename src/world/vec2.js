export function add(a, b) {
    return {
        x: a.x + b.x,
        y: a.y + b.y
    };
}

export function sub(a, b) {
    return {
        x: a.x - b.x,
        y: a.y - b.y
    };
}

export function mul(v, scalar) {
    return {
        x: v.x * scalar,
        y: v.y * scalar
    };
}

export function length(v) {
    return Math.hypot(v.x, v.y);
}

export function normalize(v) {
    const len = length(v);

    if (len === 0) {
        return { x: 0, y: 0 };
    }

    return {
        x: v.x / len,
        y: v.y / len
    };
}

export function distance(a, b) {
    return Math.hypot(
        b.x - a.x,
        b.y - a.y
    );
}

export function distanceSquared(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;

    return dx * dx + dy * dy;
}

export function lerp(a, b, t) {
    return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
    };
}
