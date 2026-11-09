// Idiomas: nomes, códigos para tradução e detecção automática do idioma do texto.

const displayNames = (() => {
  try { return new Intl.DisplayNames(['pt-BR'], { type: 'language' }); } catch { return null; }
})();

const capitalize = (s) => (s ? s.charAt(0).toLocaleUpperCase('pt-BR') + s.slice(1) : s);

export function baseLang(code) {
  return String(code || '').split(/[-_]/)[0].toLowerCase();
}

export function langName(code) {
  if (!code) return '';
  try {
    return capitalize(displayNames?.of(code) || code);
  } catch {
    return code;
  }
}

/** Código usado pelo serviço de tradução para uma localidade de voz. */
export function translationCode(locale) {
  const l = String(locale || '').toLowerCase();
  if (l.startsWith('zh')) return /tw|hk|hant|mo/.test(l) ? 'zh-TW' : 'zh-CN';
  if (l === 'pt-pt') return 'pt-PT';
  if (l.startsWith('nb') || l.startsWith('nn') || l === 'no') return 'no';
  if (l.startsWith('fil')) return 'tl';
  if (l === 'he' || l.startsWith('he-') || l.startsWith('iw')) return 'iw';
  return baseLang(l);
}

/** Dois códigos representam o mesmo idioma para fins de narração (sem tradução)? */
export function sameLanguage(a, b) {
  if (!a || !b) return true;
  const ta = translationCode(a);
  const tb = translationCode(b);
  if (ta === tb) return true;
  // Português do Brasil e de Portugal: lidos sem tradução.
  return baseLang(a) === baseLang(b) && baseLang(a) !== 'zh';
}

/** Idiomas oferecidos como "idioma do texto" do PDF. */
export const BOOK_LANGUAGES = [
  'pt', 'en', 'es', 'fr', 'de', 'it', 'nl', 'ru', 'uk', 'pl', 'cs', 'sv', 'da', 'no', 'fi',
  'el', 'tr', 'ro', 'hu', 'ar', 'he', 'hi', 'ja', 'zh', 'ko', 'id', 'vi', 'th', 'ca', 'gl', 'la'
];

const STOPWORDS = {
  pt: 'de que não uma para com os as se mais por como mas foi ele ela das dos ao à é está também são seu sua muito quando já pelo pela isso essa este esta você eu nós eles tem ter era há nos num numa ou sem até depois então aqui só',
  en: 'the and of to is in that it was for with as on be at by this had not are but from they you which his her have were would there their what been one all will can she an we if so about when who more them some could into than then its these my out him only do any',
  es: 'el la de que y los las en un una por con no es se del para como más pero su al lo está muy también fue sus ya porque cuando hay le era ser sobre este esta todo entre sin hasta desde nos ni yo él ella usted',
  fr: 'le la les de des et est un une que qui dans pour pas sur au avec ce il elle ne se du plus sont mais nous vous était aux cette son ses leur être fait comme tout bien sans où ont lui même aussi',
  de: 'der die das und ist nicht ein eine zu den von mit sich auf für dem des im es auch wie als aber wird war sie ich nach bei noch wir er sind oder einer nur hat über dieser durch wenn kann',
  it: 'il di che è la e un una per non con del della sono gli le si da al nel ma come anche più alla questo lo ha era essere nella delle dei sua suo loro tutto quando ancora molto io lui lei',
  nl: 'de het een en van is dat op te in zijn niet met voor die er aan ook als maar om bij was door naar worden wordt hij zij ik wat nog dan heeft geen kan',
  sv: 'och att det som en är på för av med den till inte har de om ett var jag han hon men ska kan så från eller',
  pl: 'i w nie na się z że do to jest jak o co ale po tak za od przez jego jej są był była może tylko',
  tr: 've bir bu da de için ile çok ne daha gibi olan ama ki o en kadar sonra şey değil var',
  ro: 'și de la în că nu cu pe o un este care mai din se pentru sunt dar ce fost'
};

const STOP_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v.split(' '))]));

/**
 * Detecta o idioma predominante de um texto (offline, heurístico).
 * @returns {{lang: string|null, confidence: number}}
 */
export function detectLanguage(text) {
  const sample = String(text || '').slice(0, 20000);
  if (sample.replace(/\s+/g, '').length < 20) return { lang: null, confidence: 0 };

  const count = (re) => (sample.match(re) || []).length;
  const letters = count(/\p{L}/gu) || 1;
  const scripts = [
    ['ja', count(/[぀-ヿ]/g) * 3],
    ['ko', count(/[가-힯]/g)],
    ['zh', count(/[一-鿿]/g)],
    ['ru', count(/[Ѐ-ӿ]/g)],
    ['el', count(/[Ͱ-Ͽ]/g)],
    ['ar', count(/[؀-ۿ]/g)],
    ['he', count(/[֐-׿]/g)],
    ['hi', count(/[ऀ-ॿ]/g)],
    ['th', count(/[฀-๿]/g)]
  ].sort((a, b) => b[1] - a[1]);
  if (scripts[0][1] / letters > 0.3) {
    let lang = scripts[0][0];
    if (lang === 'zh' && count(/[぀-ヿ]/g) > 0) lang = 'ja';
    if (lang === 'ru' && /[їєіґ]/i.test(sample)) lang = 'uk';
    return { lang, confidence: 0.9 };
  }

  const words = sample.toLowerCase().match(/\p{L}+/gu) || [];
  if (words.length < 8) return { lang: null, confidence: 0 };
  const scores = {};
  for (const [lang, set] of Object.entries(STOP_SETS)) {
    let hits = 0;
    for (const w of words) if (set.has(w)) hits++;
    scores[lang] = hits / words.length;
  }
  // Pistas ortográficas para desempatar línguas próximas.
  if (/[ãõ]|ção|ções/.test(sample)) scores.pt += 0.04;
  if (/ñ|¿|¡|ción\b/.test(sample)) scores.es += 0.04;
  if (/[ß]|ung\b|sch/.test(sample)) scores.de += 0.01;
  if (/\b(qu'|l'|d'|n')/.test(sample)) scores.fr += 0.02;

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (best[1] < 0.05) return { lang: null, confidence: 0 };
  return { lang: best[0], confidence: Math.min(1, (best[1] - second[1]) * 6 + best[1]) };
}

/** Frase de teste para a voz, no idioma dela. */
export function sampleSentence(lang) {
  const map = {
    pt: 'Olá! Esta é a voz que vai ler o seu livro.',
    en: 'Hello! This is the voice that will read your book.',
    es: '¡Hola! Esta es la voz que leerá tu libro.',
    fr: 'Bonjour ! Voici la voix qui lira votre livre.',
    de: 'Hallo! Das ist die Stimme, die dein Buch vorlesen wird.',
    it: 'Ciao! Questa è la voce che leggerà il tuo libro.',
    ja: 'こんにちは。これはあなたの本を読む声です。',
    zh: '你好！这是将为你朗读这本书的声音。',
    ko: '안녕하세요! 이 목소리가 당신의 책을 읽어 드립니다.',
    ru: 'Здравствуйте! Этот голос будет читать вашу книгу.',
    nl: 'Hallo! Dit is de stem die je boek zal voorlezen.'
  };
  return map[baseLang(lang)] || null;
}
