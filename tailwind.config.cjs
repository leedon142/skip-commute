// index.html의 Tailwind 클래스를 미리 CSS로 만들어 둠 (CDN 없이 동작). 클래스를 바꾸면 npm run css
module.exports = {
  content: ['./index.html'],
  // JS에서 색 이름을 이어 붙여 만드는 클래스 (예: bg-${tone}-50, text-${c}-700)
  safelist: [{ pattern: /^(bg|text|border)-(slate|emerald|amber|rose|blue)-(50|100|500|700)$/ }],
};
