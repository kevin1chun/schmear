# Builds the tier grid from AA Intelligence Index v5.0.1 per-effort scores (artificialanalysis.ai/models/<id>, 2026-11-21).
import json
E = ["low", "medium", "high", "xhigh", "max"]
REF = {1: [19, 25, 30, 35, 36], 2: [26, 31, 42, 50, 55], 3: [35, 48, 52, 57, 59], 4: [54, 56, 62, 62, 65]}
CLAUDE = {1: "haiku", 2: "sonnet", 3: "opus", 4: "fable"}
# lane -> model -> {effort offered on that lane: AA score or None (unmeasured)}
LANES = {
 "codex": {"gpt-5.6-terra": dict(low=None, medium=None, high=None, xhigh=None, max=32),
           "gpt-5.6-luna": dict(low=None, medium=None, high=None, xhigh=None, max=24)},
 "grok": {"grok-4.7": dict(low=31, medium=None, high=35, xhigh=35)},
 "agy-gemini": {"gemini-4-neon": dict(low=44, medium=55, high=60, xhigh=61),
                "gemini-4-hydrogen": dict(low=27, medium=41, high=51, xhigh=54)},
 "agy-argon": {"gemini-4-argon": dict(low=None, medium=48, high=50)},
 "agy-3p": {"claude-opus-5-5": dict(low=35, medium=48, high=52),
            "claude-sonnet-5-5": dict(low=26, medium=31, high=42)},
}
def lower_bound(eff):  # unmeasured effort takes the nearest lower measured score
    out, last = {}, None
    for e in E:
        if e in eff:
            last = eff[e] if eff[e] is not None else last
            if last is not None: out[e] = last
    return out
grid = {"claude": {str(t): {e: {"model": CLAUDE[t], "effort": e} for e in E} for t in REF}}
for lane, models in LANES.items():
    g = grid[lane] = {}
    for t in REF:
        g[str(t)] = {}
        for i, e in enumerate(E):
            if t == 4: g["4"][e] = None; continue  # tier 4 = Fable only (owner ruling)
            # never below the requested effort, except that a missing effort clamps to the model's highest
            c = [(s, E.index(pe), m, pe) for m, eff in models.items()
                 for pe, s in lower_bound(eff).items()
                 if s >= REF[t][i] and E.index(pe) >= min(i, max(E.index(x) for x in eff))]
            g[str(t)][e] = ({"model": min(c)[2], "effort": min(c)[3]} if c else None)
def md(lane):
    rows = ["| tier \\ effort | " + " | ".join(E) + " |", "|---|" + "---|" * 5]
    for t in "1234":
        cells = [("—" if (x := grid[lane][t][e]) is None else f"{x['model']} / {x['effort']}") for e in E]
        rows.append(f"| {t} | " + " | ".join(cells) + " |")
    return "\n".join(rows)
for lane in grid: print("###", lane); print(md(lane)); print()
print(json.dumps(grid, indent=1))
