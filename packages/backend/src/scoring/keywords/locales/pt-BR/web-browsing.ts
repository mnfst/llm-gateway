/**
 * PT-BR keywords for web browsing specificity detection.
 *
 * Fix P2b: every accented keyword includes an unaccented variant because
 * the trie is case-insensitive but NOT accent-insensitive. Users who type
 * without accents (common on mobile or fast typing) would otherwise be missed.
 */
export const WEB_BROWSING_KEYWORDS_PT_BR: string[] = [
  // "navegar/navegue" — with and without accent
  'navegue',
  'navegar para',
  'visite',
  'abra o site',
  'abra essa url',
  'abra a pagina',  // unaccented variant of 'abra a página'
  'abra a página',
  'clique em',
  'clique no',
  'role para baixo',
  'role para cima',
  'tire um screenshot',
  'faca um scraping',   // unaccented variant of 'faça'
  'faça um scraping',
  'raspe',
  'pesquise na web',
  'busque por',
  'rastreie',
  'va para',            // unaccented variant of 'vá para'
  'vá para',
  'preencha o formulario', // unaccented
  'preencha o formulário',
  'procure por',
  'site',
  'pagina web',         // unaccented variant of 'página web'
  'página web',
  'nessa pagina',       // unaccented
  'nessa página',
  'neste site',
  'nessa url',
  'acesse',
  'abrir o link',
  'clica aqui',
  'scroll',
];
