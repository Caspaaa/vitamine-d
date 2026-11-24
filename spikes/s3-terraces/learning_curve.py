"""Learning curve for method B: mean IoU on held-out venues vs number of labelled training venues.

  python learning_curve.py
"""
import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.model_selection import KFold

from method_b import build, postprocess, usable
from terrace_lib import N, iou, load_reference, raster_polys

ref = load_reference()
pos, neg = usable(ref)
ids = sorted(pos + neg)
X = {v: build(v) for v in ids}
Y = {v: raster_polys(ref[v]["polys"]) if v in pos else np.zeros((N, N), bool) for v in ids}
T = 0.4
rng = np.random.default_rng(1)


def fit(train):
    xs, ys = [], []
    for v in train:
        x, y = X[v].reshape(-1, X[v].shape[-1]), Y[v].reshape(-1)
        keep = y | (rng.random(y.size) < 0.2)
        xs.append(x[keep])
        ys.append(y[keep])
    clf = HistGradientBoostingClassifier(max_iter=150, learning_rate=0.08, max_leaf_nodes=15, l2_regularization=1.0, random_state=0)
    return clf.fit(np.concatenate(xs), np.concatenate(ys))


print("train venues (about 2/3 terraces)   mean IoU on held-out terraces   (3 repeats x 7 folds)")
for size in (8, 16, 24, 36, 54):
    scores = []
    for rep in range(3):
        for tr, te in KFold(7, shuffle=True, random_state=rep).split(ids):
            train = [ids[i] for i in tr]
            rng.shuffle(train)
            clf = fit(train[:size])
            for i in te:
                v = ids[i]
                if v not in pos:
                    continue
                p = clf.predict_proba(X[v].reshape(-1, X[v].shape[-1]))[:, 1].reshape(N, N)
                m = postprocess(p, T)
                scores.append(iou(Y[v], m) if m.any() else 0.0)
    print(f"{size:3d}   mean IoU {np.mean(scores):.3f}   >=0.5: {100 * np.mean(np.array(scores) >= .5):.0f}%   (n={len(scores)})", flush=True)
