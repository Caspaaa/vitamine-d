"""Method B: per-pixel terrace classifier on aerial imagery + building footprints + DSM, with venue-grouped CV.

Features are computed on a 0.25 m grid over +-20 m around each venue point (160 x 160 cells).
Positives: reference terrace polygons. Negatives: everything else at 'terrace' venues, and all cells at 'none' venues.
Venues marked unsure / occluded / noimagery are left out of training and scoring.

  python method_b.py            # builds features (cached), runs CV, writes data/pred_b_prob.npz and prints scores
"""
import json

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.model_selection import GroupKFold

from terrace_lib import CROPS, DATA, GRID, HALF, N, Atlas, building_masks, iou, load_meta, load_reference, raster_polys

FEAT = DATA / "features"
FEAT.mkdir(exist_ok=True)
NAMES = ["R", "G", "B", "L", "sat", "Lrel", "Lstd", "grad", "grad1m", "grad3m", "Lstd1m", "Lcontrast", "absLcontrast",
         "gradNorm", "gradNorm1m", "inBld", "inOwn", "dBld", "dOwn", "dVenue", "nDSM", "dsmStd", "smallObj"]
_atlas = Atlas()


def box_resize(plane, box):
    return np.asarray(Image.fromarray(plane.astype(np.float32), mode="F").resize((N, N), Image.BOX, box=box), dtype=np.float32)


def build(vid):
    f = FEAT / f"{vid}.npy"
    if f.exists():
        return np.load(f)
    meta = load_meta(vid)
    img = np.asarray(Image.open(CROPS / f"{vid}.jpg").convert("RGB"), dtype=np.float32) / 255
    c, r = img.shape[0] / 2, HALF / meta["mpp"]
    box = (c - r, c - r, c + r, c + r)
    R, G, B = (box_resize(img[..., i], box) for i in range(3))
    Lfull = 0.299 * img[..., 0] + 0.587 * img[..., 1] + 0.114 * img[..., 2]
    L, L2 = box_resize(Lfull, box), box_resize(Lfull ** 2, box)
    gy, gx = np.gradient(ndi.gaussian_filter(Lfull, 1.0))
    grad = box_resize(np.hypot(gx, gy), box)
    mx, mn = np.maximum(np.maximum(R, G), B), np.minimum(np.minimum(R, G), B)
    sat = (mx - mn) / (mx + 1e-3)
    Lrel = L / (ndi.gaussian_filter(L, 40) + 1e-3)
    Lstd = np.sqrt(np.maximum(L2 - L * L, 0))
    gauss = lambda a, s: ndi.gaussian_filter(a, s)
    Lc = L - gauss(L, 8)
    gnorm = grad / (L + 0.05)

    allm, ownm, _, _ = building_masks(vid)
    yy, xx = np.mgrid[0:N, 0:N]
    dven = np.hypot((xx + 0.5) * GRID - HALF, HALF - (yy + 0.5) * GRID)
    dbld = ndi.distance_transform_edt(~allm) * GRID if allm.any() else np.full((N, N), 20.0)
    down = ndi.distance_transform_edt(~ownm) * GRID if ownm.any() else np.full((N, N), 20.0)
    dsm, dtm = _atlas.sample("dsm", meta["lng"], meta["lat"]), _atlas.sample("dtm", meta["lng"], meta["lat"])
    ndsm = np.clip(dsm - dtm, -1, 30)
    feats = [R, G, B, L, sat, Lrel, Lstd, grad, gauss(grad, 4), gauss(grad, 12), gauss(Lstd, 4), Lc, np.abs(Lc), gnorm,
             gauss(gnorm, 4), allm.astype(np.float32), ownm.astype(np.float32), np.minimum(dbld, 20), np.minimum(down, 20),
             np.minimum(dven, 20), ndsm, np.sqrt(np.maximum(gauss(dsm ** 2, 6) - gauss(dsm, 6) ** 2, 0)),
             ((ndsm > 0.3) & (ndsm < 3.0)).astype(np.float32)]
    out = np.stack(feats, -1).astype(np.float32)
    np.save(f, out)
    return out


def usable(ref):
    """(positives, negatives) venue ids with imagery and a firm label."""
    pos = [v for v, r in ref.items() if r["status"] == "terrace" and r["polys"]]
    neg = [v for v, r in ref.items() if r["status"] == "none"]
    return pos, neg


def postprocess(p, t, min_area_m2=5.0, max_dist=15.0, sigma=2.0, close=3):
    ps = ndi.gaussian_filter(p, sigma)
    m = ps > t
    if close:
        st = ndi.generate_binary_structure(2, 1)
        m = ndi.binary_closing(m, structure=ndi.iterate_structure(st, close))
    m = ndi.binary_fill_holes(m)
    lab, n = ndi.label(m)
    keep = np.zeros_like(m)
    yy, xx = np.mgrid[0:N, 0:N]
    dven = np.hypot((xx + 0.5) * GRID - HALF, HALF - (yy + 0.5) * GRID)
    for i in range(1, n + 1):
        comp = lab == i
        if comp.sum() * GRID * GRID >= min_area_m2 and dven[comp].min() <= max_dist:
            keep |= comp
    return keep


def main():
    ref = load_reference()
    pos, neg = usable(ref)
    ids = sorted(pos + neg)
    print(f"{len(pos)} terraces, {len(neg)} negatives; building features...", flush=True)
    X = {v: build(v) for v in ids}
    Y = {v: raster_polys(ref[v]["polys"]) if v in pos else np.zeros((N, N), bool) for v in ids}
    rng = np.random.default_rng(0)
    probs = {}
    folds = GroupKFold(n_splits=10)
    groups = np.arange(len(ids))
    for k, (tr, te) in enumerate(folds.split(ids, groups=groups)):
        xs, ys = [], []
        for i in tr:
            v = ids[i]
            x, y = X[v].reshape(-1, X[v].shape[-1]), Y[v].reshape(-1)
            keep = y | (rng.random(y.size) < 0.2)
            xs.append(x[keep])
            ys.append(y[keep])
        clf = HistGradientBoostingClassifier(max_iter=150, learning_rate=0.08, max_leaf_nodes=15, l2_regularization=1.0, random_state=0)
        clf.fit(np.concatenate(xs), np.concatenate(ys))
        for i in te:
            v = ids[i]
            probs[v] = clf.predict_proba(X[v].reshape(-1, X[v].shape[-1]))[:, 1].reshape(N, N).astype(np.float32)
        print(f"fold {k + 1}/10 done", flush=True)
    np.savez_compressed(DATA / "pred_b_prob.npz", **probs)

    best = None
    for t in (0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6):
        ious, found, fp = [], 0, 0
        for v in pos:
            m = postprocess(probs[v], t)
            ious.append(iou(Y[v], m) if m.any() else 0.0)
            found += bool(m.any())
        for v in neg:
            fp += bool(postprocess(probs[v], t).any())
        print(f"t={t:.2f}  mean IoU {np.mean(ious):.3f}  median {np.median(ious):.3f}  IoU>=0.5: {sum(i >= .5 for i in ious)}  found {found}/{len(pos)}  false alarms {fp}/{len(neg)}")
        if best is None or np.mean(ious) > best[1]:
            best = (t, np.mean(ious))
    print("best threshold", best)
    json.dump({"threshold": best[0]}, open(DATA / "pred_b_cfg.json", "w"))


if __name__ == "__main__":
    main()
