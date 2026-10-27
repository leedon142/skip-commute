"""서울교통공사 지하철 혼잡도(30분 단위) CSV → 추천 엔진용 JSON.

data.go.kr '서울교통공사_지하철혼잡도정보' 파일데이터(CP949)를 data/raw/subway_congestion.csv로 저장한 뒤 실행.
사용법: python subway_congestion.py
"""
import csv
import json
import re
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / "raw" / "subway_congestion.csv"
OUT = HERE / "subway_congestion.json"


def main():
    with open(SRC, encoding="cp949", newline="") as f:
        rows = list(csv.reader(f))
    header, rows = rows[0], rows[1:]
    slots = []
    for h in header[5:]:
        m = re.match(r"(\d+)시(\d+)분", h)
        slots.append(f"{int(m.group(1)) % 24:02d}:{m.group(2)}")

    data = {}
    for day, line, _no, station, direction, *vals in rows:
        values = [float(v) if v.strip() else None for v in vals]
        data.setdefault(day, {}).setdefault(line, {}).setdefault(station, {})[direction] = values

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"source": SRC.name, "slots": slots, "data": data}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{OUT} · {len(rows)}행 · 시간대 {slots[0]}~{slots[-1]}")


if __name__ == "__main__":
    main()
