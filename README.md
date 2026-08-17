# Dota 2 prediction

## Cache

Run `meta.js` to fill `matches-cache.json` with match data from the last N tournaments (OpenDota).

```bash
node meta.js
```

All other scripts read from this cache only.

## Player hero winrates
## это косвенный индикатор "комфорта" на пике

Show each player's tournament winrate on the hero they played in a match:

```bash
cat > matches.txt << 'EOF'
8946337070
8946414154
8946495628
8943202720
8943278347
8943357930
8944475950
8944525313
8944570404
8946740853
8946860406
8946996385
8946648249
8946758310
8946889239
8944841068
8944931337
8945052416
EOF

while read -r id; do
  node player_hero_winrates.js "$id"
done < matches.txt
```
