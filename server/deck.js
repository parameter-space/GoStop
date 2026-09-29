// 화투 48장 덱 정의
// 쌍피 배치: 11/12월은 고정 쌍피 1장씩. 9월은 고정 쌍피가 없고, 대신 국화(열끗) 카드가
// 열끗<->쌍피 자유 전환되는 플렉스 카드(flexCard)라 9월 피 2장은 둘 다 그냥 피(piValue:1)다.
// 실제 카드 이미지 에셋이 정해지면 이 파일만 맞춰 수정하면 된다.

function card(id, month, type, name, extra = {}) {
  return { id, month, type, name, ...extra };
}

function buildDeck() {
  const cards = [];

  // 1월 - 송학
  cards.push(card('1-gwang', 1, 'gwang', '송학(광)'));
  cards.push(card('1-tti', 1, 'tti', '1월 홍단', { ribbonColor: 'hong' }));
  cards.push(card('1-pi-a', 1, 'pi', '1월 피', { piValue: 1 }));
  cards.push(card('1-pi-b', 1, 'pi', '1월 피', { piValue: 1 }));

  // 2월 - 매조
  cards.push(card('2-yeolkkeut', 2, 'yeolkkeut', '매조(열끗)', { godori: true }));
  cards.push(card('2-tti', 2, 'tti', '2월 홍단', { ribbonColor: 'hong' }));
  cards.push(card('2-pi-a', 2, 'pi', '2월 피', { piValue: 1 }));
  cards.push(card('2-pi-b', 2, 'pi', '2월 피', { piValue: 1 }));

  // 3월 - 벚꽃
  cards.push(card('3-gwang', 3, 'gwang', '벚꽃(광)'));
  cards.push(card('3-tti', 3, 'tti', '3월 홍단', { ribbonColor: 'hong' }));
  cards.push(card('3-pi-a', 3, 'pi', '3월 피', { piValue: 1 }));
  cards.push(card('3-pi-b', 3, 'pi', '3월 피', { piValue: 1 }));

  // 4월 - 흑싸리
  cards.push(card('4-yeolkkeut', 4, 'yeolkkeut', '흑싸리(열끗)', { godori: true }));
  cards.push(card('4-tti', 4, 'tti', '4월 초단', { ribbonColor: 'cho' }));
  cards.push(card('4-pi-a', 4, 'pi', '4월 피', { piValue: 1 }));
  cards.push(card('4-pi-b', 4, 'pi', '4월 피', { piValue: 1 }));

  // 5월 - 난초
  cards.push(card('5-yeolkkeut', 5, 'yeolkkeut', '난초(열끗)'));
  cards.push(card('5-tti', 5, 'tti', '5월 초단', { ribbonColor: 'cho' }));
  cards.push(card('5-pi-a', 5, 'pi', '5월 피', { piValue: 1 }));
  cards.push(card('5-pi-b', 5, 'pi', '5월 피', { piValue: 1 }));

  // 6월 - 모란
  cards.push(card('6-yeolkkeut', 6, 'yeolkkeut', '모란(열끗)'));
  cards.push(card('6-tti', 6, 'tti', '6월 청단', { ribbonColor: 'cheong' }));
  cards.push(card('6-pi-a', 6, 'pi', '6월 피', { piValue: 1 }));
  cards.push(card('6-pi-b', 6, 'pi', '6월 피', { piValue: 1 }));

  // 7월 - 홍싸리
  cards.push(card('7-yeolkkeut', 7, 'yeolkkeut', '홍싸리(열끗)'));
  cards.push(card('7-tti', 7, 'tti', '7월 초단', { ribbonColor: 'cho' }));
  cards.push(card('7-pi-a', 7, 'pi', '7월 피', { piValue: 1 }));
  cards.push(card('7-pi-b', 7, 'pi', '7월 피', { piValue: 1 }));

  // 8월 - 공산 (띠 없음)
  cards.push(card('8-gwang', 8, 'gwang', '공산(광)'));
  cards.push(card('8-yeolkkeut', 8, 'yeolkkeut', '기러기(열끗)', { godori: true }));
  cards.push(card('8-pi-a', 8, 'pi', '8월 피', { piValue: 1 }));
  cards.push(card('8-pi-b', 8, 'pi', '8월 피', { piValue: 1 }));

  // 9월 - 국화 (열끗↔쌍피 자유 전환 가능한 하우스 룰 대상)
  cards.push(card('9-yeolkkeut', 9, 'yeolkkeut', '국화(열끗)', { flexCard: true }));
  cards.push(card('9-tti', 9, 'tti', '9월 청단', { ribbonColor: 'cheong' }));
  cards.push(card('9-pi-a', 9, 'pi', '9월 피', { piValue: 1 }));
  cards.push(card('9-pi-b', 9, 'pi', '9월 피', { piValue: 1 }));

  // 10월 - 단풍
  cards.push(card('10-yeolkkeut', 10, 'yeolkkeut', '단풍(열끗)'));
  cards.push(card('10-tti', 10, 'tti', '10월 청단', { ribbonColor: 'cheong' }));
  cards.push(card('10-pi-a', 10, 'pi', '10월 피', { piValue: 1 }));
  cards.push(card('10-pi-b', 10, 'pi', '10월 피', { piValue: 1 }));

  // 11월 - 오동 (띠, 열끗 없음)
  cards.push(card('11-gwang', 11, 'gwang', '오동(광)'));
  cards.push(card('11-pi-a', 11, 'pi', '11월 쌍피', { piValue: 2 }));
  cards.push(card('11-pi-b', 11, 'pi', '11월 피', { piValue: 1 }));
  cards.push(card('11-pi-c', 11, 'pi', '11월 피', { piValue: 1 }));

  // 12월 - 비 (일반 피 없음, 띠는 홍단/청단/초단 등 색깔 조합엔 미포함이지만 "띠 5장 이상" 개수엔 포함)
  cards.push(card('12-gwang', 12, 'gwang', '비광', { isRainGwang: true }));
  cards.push(card('12-yeolkkeut', 12, 'yeolkkeut', '제비(열끗)'));
  cards.push(card('12-tti', 12, 'tti', '비띠', { ribbonColor: null }));
  cards.push(card('12-pi', 12, 'pi', '비 쌍피', { piValue: 2 }));

  // 보너스패 2장 (하우스 룰): month 없음. 손패에서 내면 각 상대 피 1장씩 받아오고
  // 덱에서 한 장을 손패로 가져온 뒤 정식으로 한 번 더 낸다. 덱을 뒤집다가 나오면
  // 즉시 자기 창고로 가져가고 덱에서 한 장을 더 뒤집는다. 어느 쪽이든 쌍피로 계산.
  cards.push(card('bonus-1', null, 'bonus', '보너스패', { piValue: 2, isBonus: true }));
  cards.push(card('bonus-2', null, 'bonus', '보너스패', { piValue: 2, isBonus: true }));

  return cards;
}

// 9월 국화(열끗) 카드: 열끗으로도 쌍피로도 셀 수 있는 하우스 룰 대상 카드의 id
const FLEX_CARD_ID = '9-yeolkkeut';

module.exports = { buildDeck, FLEX_CARD_ID };
