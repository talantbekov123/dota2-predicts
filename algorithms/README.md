# Algorithms

Run one file against a match list:

```bash
node algorithms/run.js draft-signals-third -f wallachia-matches.txt
node algorithms/run.js draft-signals-third -f backtest-matches.txt
```

`backtest-matches.txt` is BLAST Slam VIII. Each algorithm only sees matches that already finished.

## Results

| Algorithm | BLAST Slam | Wallachia | Notes |
|---|---|---|---|
| `team-winrate` | 36/60 (60%) | — | Higher past team win rate |
| `draft-signals` | 45/60 (75%) | — | Tuned on BLAST |
| `draft-signals-second` | 12/14 (85.7%) | 19/39 (48.7%) | Skips prices under 1.45 |
| `draft-signals-third` | 13/17 (76.5%) | 31/45 (68.9%) | Bets only at 1.50–4.00 |

`draft-signals-third` is the betting version. A 5% stake of a $1,000 bank, Wallachia first and then BLAST Slam, finishes at **$4,296.75**.
