import {
    distance,
    lerp
} from "./vec2.js";

export function polylineLength(points) {
    let total = 0;

    for (let i = 1; i < points.length; i++) {
        total += distance(
            points[i - 1],
            points[i]
        );
    }

    return total;
}

export function closestPointOnSegment(point, a, b) {
    const abX = b.x - a.x;
    const abY = b.y - a.y;

    const abLengthSquared = abX * abX + abY * abY;

    if (abLengthSquared === 0) {
        return {
            point: { ...a },
            t: 0,
            distance: distance(point, a)
        };
    }

    const apX = point.x - a.x;
    const apY = point.y - a.y;

    const t = Math.max(
        0,
        Math.min(
            1,
            (apX * abX + apY * abY) / abLengthSquared
        )
    );

    const closest = lerp(a, b, t);

    return {
        point: closest,
        t,
        distance: distance(point, closest)
    };
}

export function closestPointOnPolyline(point, points) {
    if (points.length < 2) return null;

    let best = null;
    let accumulated = 0;

    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];

        const segmentLength = distance(a, b);
        const result = closestPointOnSegment(point, a, b);
        const distanceAlong = accumulated + segmentLength * result.t;

        if (best === null || result.distance < best.distance) {
            best = {
                point: result.point,
                distance: result.distance,
                segmentIndex: i - 1,
                t: result.t,
                distanceAlong,
            };
        }

        accumulated += segmentLength;
    }

    return best;
}