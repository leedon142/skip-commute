"""국민대를 지나는 버스 노선의 정류장별·시간대별 승하차 분석.

서울 열린데이터광장 CardBusTimeNew API 사용.
사용법: python bus_boarding.py <인증키> [YYYYMM]
"""
import csv
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

# 국민대 주변 정류장(08107, 08110, 08111, 08112, 08393)에 실제로 서는 노선
ROUTES = ["7211", "1213", "1711", "1020", "163", "171", "110A", "110B", "1116"]
WINDOW = 8  # 국민대 정류장 앞뒤로 볼 정류장 수
OUT = Path(__file__).parent / "out"


def fetch_route(key, ym, route):
    rows, start = [], 1
    while True:
        url = (f"http://openapi.seoul.go.kr:8088/{key}/json/CardBusTimeNew/"
               f"{start}/{start + 999}/{ym}/{urllib.parse.quote(route)}/")
        with urllib.request.urlopen(url, timeout=30) as r:
            data = json.load(r)
        body = data.get("CardBusTimeNew")
        if not body:
            print(f"  [{route}] {data}")
            return rows
        rows += body["row"]
        if len(rows) >= body["list_total_count"]:
            return rows
        start += 1000


def hour_val(row, h, kind):
    # 1시 컬럼만 이름이 NOPE로 다름
    for k in (f"HR_{h}_{kind}_TNOPE", f"HR_{h}_{kind}_NOPE"):
        if k in row:
            return int(row[k])
    return 0


def parse(row):
    m = re.match(r"(.*)\((\d+)\)$", row["SBWY_STNS_NM"])
    name, seq = (m.group(1), int(m.group(2))) if m else (row["SBWY_STNS_NM"], 0)
    on = [hour_val(row, h, "GET_ON") for h in range(24)]
    off = [hour_val(row, h, "GET_OFF") for h in range(24)]
    return {"route": row["RTE_NO"], "seq": seq, "stop": name,
            "ars": row["STOPS_ARS_NO"], "on": on, "off": off}


def main():
    import os
    key = (sys.argv[1] if len(sys.argv) > 1 else "") or os.environ.get("SEOUL_OPENDATA_KEY")
    if not key:
        sys.exit("사용법: python bus_boarding.py <인증키> [YYYYMM]  (또는 SEOUL_OPENDATA_KEY 환경변수)")
    ym = sys.argv[2] if len(sys.argv) > 2 else "202609"
    OUT.mkdir(exist_ok=True)
    profile = {"month": ym, "routes": {}}

    with open(OUT / f"kookmin_window_{ym}.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["노선", "순번", "정류장", "ARS", "구분"] + [f"{h}시" for h in range(24)] + ["합계"])
        for route in ROUTES:
            stops = sorted((parse(r) for r in fetch_route(key, ym, route)), key=lambda s: s["seq"])
            profile["routes"][route] = [{k: s[k] for k in ("seq", "ars", "stop", "on", "off")} for s in stops]
            hits = [i for i, s in enumerate(stops) if "국민대" in s["stop"]]
            if not hits:
                print(f"\n[{route}] 국민대 정류장 없음 (정류장 {len(stops)}개)")
                continue
            # 왕복 노선은 국민대를 두 번 지나므로 지나는 지점마다 앞뒤를 따로 봄
            idx = sorted({j for i in hits for j in range(max(0, i - WINDOW), min(len(stops), i + WINDOW + 1))})
            print(f"\n[{route}] 국민대 앞뒤 {WINDOW}정류장 · 월 누적 승차/하차 (하루 전체 | 8시대 | 17시대 | 18시대)")
            prev = None
            for j in idx:
                if prev is not None and j != prev + 1:
                    print("   ...")
                prev = j
                s = stops[j]
                mark = "★" if "국민대" in s["stop"] else " "
                print(f" {mark}{s['seq']:>3} {s['ars']} {s['stop'][:16]:<16} "
                      f"승{sum(s['on']):>6} 하{sum(s['off']):>6} | "
                      f"{s['on'][8]:>5}/{s['off'][8]:<5}| {s['on'][17]:>5}/{s['off'][17]:<5}| {s['on'][18]:>5}/{s['off'][18]:<5}")
                for kind in ("on", "off"):
                    w.writerow([route, s["seq"], s["stop"], s["ars"], "승차" if kind == "on" else "하차"]
                               + s[kind] + [sum(s[kind])])
    # 추천 엔진이 읽는 노선별 전체 정류장 승하차 프로필
    with open(Path(__file__).parent / "boarding_profile.json", "w", encoding="utf-8") as f:
        json.dump(profile, f, ensure_ascii=False, separators=(",", ":"))
    print(f"\n저장: {OUT / f'kookmin_window_{ym}.csv'}, data/boarding_profile.json")


if __name__ == "__main__":
    main()
