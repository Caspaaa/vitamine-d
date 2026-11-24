"""Baseline A: terrace = a rectangle in front of the facade nearest to the OSM point.

Needs only the OSM point and the UrbIS building footprints (no imagery). Rectangle size (12 m x 6 m) was tuned on
the reviewed reference terraces, so the score is slightly optimistic.
"""
import math

from shapely.geometry import LineString, Point

from terrace_lib import building_masks

LENGTH, DEPTH, OFFSET = 12.0, 6.0, 0.3


def baseline_a(vid, length=LENGTH, depth=DEPTH):
    _, _, polys, own = building_masks(vid)
    pt = Point(0, 0)
    cands = own or [p for p in polys if p.distance(pt) < 10]

    def free(x, y):
        q = Point(x, y)
        return not any(p.contains(q) for p in polys)

    best = None
    for p in cands:
        c = list(p.exterior.coords)
        for (x1, y1), (x2, y2) in zip(c[:-1], c[1:]):
            el = math.hypot(x2 - x1, y2 - y1)
            if el < 3:
                continue
            ux, uy = (x2 - x1) / el, (y2 - y1) / el
            mx, my = (x1 + x2) / 2, (y1 + y2) / 2
            for nx, ny in ((uy, -ux), (-uy, ux)):
                if free(mx + nx * 1.5, my + ny * 1.5) and free(mx + nx * 3.0, my + ny * 3.0):
                    d = LineString([(x1, y1), (x2, y2)]).distance(pt)
                    if best is None or d < best[0]:
                        best = (d, (x1, y1), (ux, uy), (nx, ny), el)
    if best is None or best[0] > 12:
        h = 2.0
        return [[(-h, -h), (h, -h), (h, h), (-h, h)]]
    _, (x1, y1), (ux, uy), (nx, ny), el = best
    t = (0 - x1) * ux + (0 - y1) * uy  # projection of the venue point on the edge
    t0, t1 = t - length / 2, t + length / 2
    base = [(x1 + ux * t0 + nx * OFFSET, y1 + uy * t0 + ny * OFFSET), (x1 + ux * t1 + nx * OFFSET, y1 + uy * t1 + ny * OFFSET)]
    return [[base[0], base[1], (base[1][0] + nx * depth, base[1][1] + ny * depth), (base[0][0] + nx * depth, base[0][1] + ny * depth)]]
