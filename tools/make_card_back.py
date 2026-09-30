"""카드 뒷면 무늬 타일(public/assets/cards/back.webp)을 직접 그린다.

전통 물결무늬(세이가이하, 青海波)를 코드로 생성한다 - 외부 이미지를 쓰지 않으므로 출처가
분명하다. 타일은 가로/세로로 이어 붙여도 이음새가 없다(가로 주기 2R, 세로 주기 R).
사용: python tools/make_card_back.py
"""
import math
from PIL import Image

R = 40            # 원 반지름(고해상도 기준 px)
RINGS = 4         # 원 하나에 들어가는 동심 띠 수
SS = 4            # 슈퍼샘플링 배율(가장자리를 부드럽게)
OUT_W, OUT_H = 60, 30  # 최종 타일 크기(CSS background-size가 이 비율로 줄여 쓴다)
KHAKI = (144, 128, 96)
GOLD = (128, 102, 0)

W, H = 2 * R, R   # 한 주기


def color_at(x, y):
    # 원 중심 격자: 행 간격 R/2, 홀수 행은 R만큼 밀림. 아래 행이 위 행을 덮는다(나중에 그림).
    best = None
    for j in range(-2, 5):
        cy = j * R / 2
        off = R if j % 2 else 0
        for i in range(-2, 3):
            cx = i * 2 * R + off
            d = math.hypot(x - cx, y - cy)
            if d < R and (best is None or j > best[0]):
                best = (j, d)
    if best is None:
        return KHAKI
    ring = int(best[1] / (R / RINGS))
    return GOLD if ring % 2 == 0 else KHAKI


big = Image.new('RGB', (W * SS, H * SS))
px = big.load()
for yy in range(H * SS):
    for xx in range(W * SS):
        px[xx, yy] = color_at((xx + 0.5) / SS, (yy + 0.5) / SS)
big.resize((OUT_W, OUT_H), Image.LANCZOS).save('public/assets/cards/back.webp', 'WEBP', quality=90)
print('wrote public/assets/cards/back.webp', OUT_W, OUT_H)
