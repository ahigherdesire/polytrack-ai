"""
bot_detection.py
================
Companion code for "How Does PolyTrack Know a Run Was Driven by a Bot?"

This is a self-contained, runnable simulation. It does NOT touch the real game.
It synthesizes input traces from two generative models -- a *human* model and a
*bot* model -- and then implements the statistical detectors derived in the
paper:

    1. Frame-quantization test        (chi^2 on sub-frame phase)
    2. Inter-event interval law       (two-sample Kolmogorov-Smirnov)
    3. Cross-run consistency          (coefficient of variation of lap time)
    4. Steering entropy               (Shannon entropy of the action stream)
    5. A pooled log-likelihood-ratio classifier + ROC/AUC

Run:
    python bot_detection.py

Dependencies: numpy only (matplotlib optional, for the --plot flag).
"""

from __future__ import annotations
import math
import argparse
import numpy as np

# ----------------------------------------------------------------------------
# 0. The world model: a deterministic, fixed-timestep game (PolyTrack-like)
# ----------------------------------------------------------------------------
# PolyTrack integrates physics at a FIXED dt = 1 ms (1000 Hz) and is bit-exact
# deterministic. A "run" is therefore fully described by the discrete sequence
# of control changes (key-down / key-up events) on the 1 ms grid. We model an
# input trace as a list of (frame_index, action) events, where frame_index is
# an integer (the only legal thing) for a bot, but for a human it is the
# *rounding* of a continuous wall-clock time onto the grid.

DT_MS = 1.0          # simulation step, milliseconds  (1000 Hz)
ACTIONS = ("left", "right", "throttle", "brake")


# ----------------------------------------------------------------------------
# 1. Generative models for input timing
# ----------------------------------------------------------------------------
def ex_gaussian(rng, mu, sigma, tau, size):
    """Ex-Gaussian (Gaussian + exponential) -- the standard model of human
    reaction / inter-response times. mu,sigma = Gaussian part; tau = exp tail."""
    return rng.normal(mu, sigma, size) + rng.exponential(tau, size)


def human_run(rng, n_events=120, base_lap_ms=18000.0):
    """A human pressing keys. Two signatures fall out naturally:
       (a) event times are continuous wall-clock -> sub-frame phase is UNIFORM;
       (b) inter-event intervals follow an ex-Gaussian (reaction-time) law;
       (c) lap-to-lap timing varies a lot (large coefficient of variation).
    Returns (event_times_ms, actions, lap_time_ms)."""
    # ex-Gaussian inter-key intervals, mean ~ base_lap/n_events
    mean_iei = base_lap_ms / n_events
    iei = ex_gaussian(rng, mu=mean_iei * 0.55, sigma=mean_iei * 0.18,
                      tau=mean_iei * 0.45, size=n_events)
    iei = np.clip(iei, 12.0, None)            # humans can't go below ~12 ms
    t = np.cumsum(iei)
    actions = rng.choice(ACTIONS, size=n_events, p=[0.28, 0.28, 0.34, 0.10])
    lap = t[-1] * (1.0 + rng.normal(0, 0.06))  # ~6% lap-time variability
    return t, actions, lap


def bot_run(rng, n_events=120, base_lap_ms=15200.0, mimic=False):
    """An optimizer/RL agent replaying a solved input plan.
       (a) every event lands EXACTLY on the 1 ms grid -> sub-frame phase = 0
           (unless `mimic` dithers it);
       (b) intervals are tightly clustered near the control horizon, can be
           frame-adjacent (1-2 ms), which humans essentially never produce;
       (c) lap time is near-identical across runs (tiny CV);
       (d) the plan is faster (that's the whole point) -> lower base_lap_ms.
    `mimic=True` is the evasion model: dither phase + inflate variability to
    look human (Section 8 of the paper)."""
    mean_iei = base_lap_ms / n_events
    # bot intervals: low spread, occasional frame-perfect bursts
    iei = rng.normal(mean_iei, mean_iei * 0.03, size=n_events)
    burst = rng.random(n_events) < 0.18
    iei[burst] = rng.choice([1.0, 2.0, 3.0], size=burst.sum())  # frame-adjacent
    iei = np.clip(iei, 1.0, None)
    t = np.cumsum(iei)
    # quantize exactly onto the grid -- the defining bot tell
    t = np.round(t / DT_MS) * DT_MS
    actions = rng.choice(ACTIONS, size=n_events, p=[0.30, 0.30, 0.33, 0.07])
    lap = t[-1] * (1.0 + rng.normal(0, 0.002))  # near-zero variability

    if mimic:
        # Evasion: add sub-frame jitter (but the grid quantization on submit
        # destroys it again -> the bound in Section 8) and inflate CV.
        t = t + rng.uniform(0, DT_MS, size=n_events)
        lap = t[-1] * (1.0 + rng.normal(0, 0.05))
    return t, actions, lap


# ----------------------------------------------------------------------------
# 2. Feature extractors (the detectors)
# ----------------------------------------------------------------------------
def feat_subframe_phase(times_ms):
    """Detector 1. Phase = fractional part of t/DT. Human ~ Uniform[0,1);
    raw bot ~ delta at 0. We return the phases for a chi^2 uniformity test."""
    return np.mod(times_ms / DT_MS, 1.0)


def chi2_uniform(phases, bins=10):
    """Chi-square goodness-of-fit against Uniform[0,1). Large stat => not human."""
    counts, _ = np.histogram(phases, bins=bins, range=(0, 1))
    expected = len(phases) / bins
    stat = np.sum((counts - expected) ** 2 / expected)
    # dof = bins-1; survival of chi^2 via regularized upper incomplete gamma
    dof = bins - 1
    p = _chi2_sf(stat, dof)
    return stat, p


def feat_intervals(times_ms):
    """Detector 2. Inter-event intervals."""
    return np.diff(np.sort(times_ms))


def ks_two_sample(a, b):
    """Two-sample Kolmogorov-Smirnov statistic D = sup|F_a - F_b|."""
    a = np.sort(a); b = np.sort(b)
    grid = np.concatenate([a, b])
    cdf_a = np.searchsorted(a, grid, side="right") / len(a)
    cdf_b = np.searchsorted(b, grid, side="right") / len(b)
    d = np.max(np.abs(cdf_a - cdf_b))
    n, m = len(a), len(b)
    en = math.sqrt(n * m / (n + m))
    # asymptotic p-value (Kolmogorov distribution)
    p = _ks_pvalue((en + 0.12 + 0.11 / en) * d)
    return d, p


def feat_consistency(lap_times_ms):
    """Detector 3. Coefficient of variation across repeated runs."""
    lap_times_ms = np.asarray(lap_times_ms)
    return lap_times_ms.std() / lap_times_ms.mean()


def feat_action_entropy(actions):
    """Detector 4. Shannon entropy (bits) of the action stream. Humans are
    noisier (higher entropy) than a clean optimal plan -- weak but additive."""
    _, counts = np.unique(actions, return_counts=True)
    p = counts / counts.sum()
    return float(-np.sum(p * np.log2(p)))


# ----------------------------------------------------------------------------
# 3. Special functions (so we depend on numpy only, not scipy)
# ----------------------------------------------------------------------------
def _chi2_sf(x, k):
    """Survival function of chi^2_k via the regularized upper incomplete gamma
    Q(k/2, x/2), computed by a simple series/continued-fraction split."""
    return _gammaincc(k / 2.0, x / 2.0)


def _gammaincc(a, x):
    if x < 0 or a <= 0:
        return float("nan")
    if x < a + 1.0:                     # series for P, then Q = 1 - P
        ap, s, term = a, 1.0 / a, 1.0 / a
        for _ in range(500):
            ap += 1.0
            term *= x / ap
            s += term
            if abs(term) < abs(s) * 1e-14:
                break
        return 1.0 - s * math.exp(-x + a * math.log(x) - math.lgamma(a))
    # continued fraction for Q directly (Lentz)
    tiny = 1e-300
    b = x + 1.0 - a; c = 1.0 / tiny; d = 1.0 / b; h = d
    for i in range(1, 500):
        an = -i * (i - a)
        b += 2.0
        d = an * d + b
        if abs(d) < tiny: d = tiny
        c = b + an / c
        if abs(c) < tiny: c = tiny
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-14:
            break
    return h * math.exp(-x + a * math.log(x) - math.lgamma(a))


def _ks_pvalue(t):
    """Kolmogorov distribution survival function Q_KS(t)."""
    if t < 1e-3:
        return 1.0
    s = 0.0
    for j in range(1, 101):
        s += (-1) ** (j - 1) * math.exp(-2.0 * j * j * t * t)
    return max(0.0, min(1.0, 2.0 * s))


# ----------------------------------------------------------------------------
# 4. Pooled log-likelihood-ratio classifier
# ----------------------------------------------------------------------------
def feature_vector(rng, runs):
    """Aggregate detectors into a feature vector for one *player* (set of runs).
    runs = list of (times, actions, lap) tuples."""
    all_times = np.concatenate([r[0] for r in runs])
    all_acts = np.concatenate([r[1] for r in runs])
    laps = [r[2] for r in runs]
    phases = feat_subframe_phase(all_times)
    chi2_stat, _ = chi2_uniform(phases)
    ieis = feat_intervals(all_times)
    frac_frameadjacent = np.mean(ieis <= 3.0)     # share of <=3 ms gaps
    cv = feat_consistency(laps)
    ent = feat_action_entropy(all_acts)
    return np.array([chi2_stat, frac_frameadjacent, ent, cv])


def fit_lr(X, y, epochs=4000, lr=0.05):
    """Tiny logistic regression (no sklearn). Standardize, gradient descent."""
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Xs = (X - mu) / sd
    Xs = np.hstack([Xs, np.ones((len(Xs), 1))])
    w = np.zeros(Xs.shape[1])
    for _ in range(epochs):
        p = 1.0 / (1.0 + np.exp(-Xs @ w))
        w -= lr * Xs.T @ (p - y) / len(y)
    return w, mu, sd


def predict_lr(X, w, mu, sd):
    Xs = (X - mu) / sd
    Xs = np.hstack([Xs, np.ones((len(Xs), 1))])
    return 1.0 / (1.0 + np.exp(-Xs @ w))


def auc(scores, labels):
    """Rank-based ROC AUC (Mann-Whitney)."""
    order = np.argsort(scores)
    ranks = np.empty_like(order, dtype=float)
    ranks[order] = np.arange(1, len(scores) + 1)
    pos = labels == 1
    n_pos, n_neg = pos.sum(), (~pos).sum()
    return (ranks[pos].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg)


# ----------------------------------------------------------------------------
# 5. Experiment
# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--players", type=int, default=400)
    ap.add_argument("--runs", type=int, default=5, help="runs per player")
    ap.add_argument("--mimic", action="store_true",
                    help="make bots try to evade (Section 8)")
    ap.add_argument("--plot", action="store_true")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)

    X, y = [], []
    for i in range(args.players):
        is_bot = i % 2 == 0
        runs = []
        for _ in range(args.runs):
            if is_bot:
                runs.append(bot_run(rng, mimic=args.mimic))
            else:
                runs.append(human_run(rng))
        X.append(feature_vector(rng, runs))
        y.append(1 if is_bot else 0)
    X = np.array(X); y = np.array(y)

    # ---- single-detector demonstrations on one bot vs one human ----
    print("=" * 68)
    print("SINGLE-DETECTOR DEMONSTRATION  (one human run vs one bot run)")
    print("=" * 68)
    ht, ha, hl = human_run(rng)
    bt, ba, bl = bot_run(rng)
    hchi, hp = chi2_uniform(feat_subframe_phase(ht))
    bchi, bp = chi2_uniform(feat_subframe_phase(bt))
    print(f"[D1 sub-frame phase chi^2]  human stat={hchi:7.2f} p={hp:.3g}"
          f"   |  bot stat={bchi:9.2f} p={bp:.3g}")
    d, pks = ks_two_sample(feat_intervals(ht), feat_intervals(bt))
    print(f"[D2 interval-law KS]        D={d:.3f}  p={pks:.3g}  "
          f"(human vs bot interval distributions differ)")
    print(f"[D4 action entropy bits]    human={feat_action_entropy(ha):.3f}"
          f"   |  bot={feat_action_entropy(ba):.3f}")

    # ---- pooled classifier ----
    n = len(X); idx = rng.permutation(n); cut = n // 2
    tr, te = idx[:cut], idx[cut:]
    w, mu, sd = fit_lr(X[tr], y[tr].astype(float))
    s = predict_lr(X[te], w, mu, sd)
    a = auc(s, y[te])
    # accuracy at 0.5 threshold
    acc = np.mean((s > 0.5).astype(int) == y[te])
    print("\n" + "=" * 68)
    print(f"POOLED LLR CLASSIFIER  (mimic={'ON' if args.mimic else 'off'})")
    print("=" * 68)
    feats = ["chi2_phase", "frac_frame_adjacent", "action_entropy", "lap_CV"]
    print("learned weights (standardized):")
    for nme, wi in zip(feats, w[:-1]):
        print(f"    {nme:22s} {wi:+.3f}")
    print(f"held-out ROC AUC = {a:.4f}   accuracy@0.5 = {acc:.3f}")

    if args.plot:
        _plots(rng)


def _plots(rng):
    import matplotlib.pyplot as plt
    ht, _, _ = human_run(rng); bt, _, _ = bot_run(rng)
    fig, ax = plt.subplots(1, 2, figsize=(11, 4))
    ax[0].hist(feat_subframe_phase(ht), bins=20, alpha=.6, density=True, label="human")
    ax[0].hist(feat_subframe_phase(bt), bins=20, alpha=.6, density=True, label="bot")
    ax[0].set_title("D1: sub-frame phase"); ax[0].set_xlabel("phase"); ax[0].legend()
    ax[1].hist(feat_intervals(ht), bins=40, alpha=.6, density=True, label="human")
    ax[1].hist(feat_intervals(bt), bins=40, alpha=.6, density=True, label="bot")
    ax[1].set_title("D2: inter-event intervals (ms)"); ax[1].set_xlabel("ms"); ax[1].legend()
    plt.tight_layout(); plt.savefig("bot_detection_features.png", dpi=120)
    print("saved bot_detection_features.png")


if __name__ == "__main__":
    main()
