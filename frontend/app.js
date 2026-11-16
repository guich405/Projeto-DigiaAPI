/* Digiescolhido — frontend em JavaScript puro.
   Fluxo: Digi-API (GET) -> banco NoSQL RESTHeart (POST/GET/PUT/PATCH/DELETE) -> quiz, mural e painel.
   Duas coleções: "digimons" (importada da API) e "duplas" (geradas pelo quiz). */

// ======================================================================
// Configuração
// ======================================================================
const BANCO = 'http://localhost:8080';                // RESTHeart no Docker
const DIGI_API = 'https://digi-api.com/api/v1/digimon'; // API de origem (somente GET)
const COL = { digimons: '/digimons', duplas: '/duplas' };
const HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': 'Basic ' + btoa('admin:secret') // usuário padrão do RESTHeart (só local)
};

const NIVEL_SORTEIO = 'Child';         // nome do nível na Digi-API (equivale a Rookie): só ele entra no sorteio
const NIVEL_ROTULO = 'Child (Rookie)'; // texto exibido na interface
const ATRIBUTOS = ['Vacina', 'Dado', 'Vírus', 'Livre'];
const ATRIBUTO_API = { Vaccine: 'Vacina', Data: 'Dado', Virus: 'Vírus', Free: 'Livre' };
const COR_ATRIBUTO = { Vacina: '#2f6fc4', Dado: '#a8650c', 'Vírus': '#7b3fa8', Livre: '#2e7d4f' };
const PERFIL = {
  Vacina: 'protetor e confiável',
  Dado: 'estratégico e curioso',
  'Vírus': 'intenso e ousado',
  Livre: 'imprevisível e sem rótulos'
};

const PERGUNTAS = [
  {
    texto: 'Seu time está em apuros no meio de uma batalha. O que você faz?',
    opcoes: [
      { texto: 'Protejo todo mundo e cuido de quem se feriu', atributo: 'Vacina' },
      { texto: 'Analiso o inimigo e monto uma estratégia', atributo: 'Dado' },
      { texto: 'Parto para cima com tudo, sem medo do risco', atributo: 'Vírus' },
      { texto: 'Improviso e sigo o instinto do momento', atributo: 'Livre' }
    ]
  },
  {
    texto: 'Num dia livre no Mundo Digital, o que você prefere fazer?',
    opcoes: [
      { texto: 'Ajudar um vilarejo a se reconstruir', atributo: 'Vacina' },
      { texto: 'Explorar ruínas e decifrar códigos antigos', atributo: 'Dado' },
      { texto: 'Testar limites onde ninguém ousou ir', atributo: 'Vírus' },
      { texto: 'Caminhar sem destino e ver o que aparece', atributo: 'Livre' }
    ]
  },
  {
    texto: 'Como seus amigos descreveriam você?',
    opcoes: [
      { texto: 'Confiável e sempre presente', atributo: 'Vacina' },
      { texto: 'Curioso e observador', atributo: 'Dado' },
      { texto: 'Intenso e imprevisível', atributo: 'Vírus' },
      { texto: 'Difícil de encaixar em uma categoria', atributo: 'Livre' }
    ]
  }
];

// ======================================================================
// Estado e utilitários
// ======================================================================
const estado = {
  conectado: false,
  erroConexao: '',
  digimons: [],
  duplas: [],
  quiz: novoQuiz(),
  graficos: {},
  log: []
};

function novoQuiz() {
  return { fase: 'nome', nome: '', etapa: 0, pontos: { Vacina: 0, Dado: 0, 'Vírus': 0, Livre: 0 },
           respostas: [], opcoes: [], travado: false, resultado: null, dupla: null };
}

const $ = (seletor, raiz = document) => raiz.querySelector(seletor);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const embaralhar = lista => {
  const a = [...lista];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const dataHora = iso => iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const chip = atributo => `<span class="chip ${norm(atributo)}">${esc(atributo)}</span>`;

function validarNome(valor) {
  const nome = valor.trim();
  if (!nome) return 'Digite seu nome para começar.';
  if (nome.length < 2) return 'O nome precisa ter pelo menos 2 caracteres.';
  if (!/^[\p{L}\p{N} '\-]+$/u.test(nome)) return 'Use apenas letras, números, espaço, hífen ou apóstrofo.';
  return '';
}

// ======================================================================
// Avisos (carregando / sucesso / erro) e registro de requisições
// ======================================================================
let temporizadorAviso;
function aviso(tipo, texto) {
  const el = $('#status');
  clearTimeout(temporizadorAviso);
  el.className = `aviso ${tipo}`;
  el.textContent = texto;
  if (tipo === 'ok') temporizadorAviso = setTimeout(() => { el.className = 'aviso'; el.textContent = ''; }, 4000);
}

function registrar(metodo, caminho, status) {
  estado.log.unshift({ metodo, caminho, status });
  estado.log = estado.log.slice(0, 20);
  $('#log-lista').innerHTML = estado.log.map(r => {
    const falhou = typeof r.status !== 'number' || r.status >= 400;
    return `<li><span class="metodo">${esc(r.metodo)}</span> ${esc(r.caminho)} <strong class="${falhou ? 'falha' : ''}">${esc(r.status)}</strong></li>`;
  }).join('');
}

class ErroHttp extends Error {
  constructor(status, texto, onde) {
    const dica = status === 401 ? ' (credenciais recusadas pelo RESTHeart)' : '';
    super(`Erro ${status} ${texto || ''} em ${onde}${dica}`.replace('  ', ' '));
    this.status = status;
  }
}

const mensagemErro = e => e.message || 'Algo deu errado. Tente de novo.';

// ======================================================================
// Camada HTTP — banco NoSQL (RESTHeart)
// O fetch não cai no catch em 404/500, então sempre conferimos res.ok.
// ======================================================================
async function req(metodo, caminho, corpo) {
  const opcoes = { method: metodo, headers: HEADERS };
  if (corpo !== undefined) opcoes.body = JSON.stringify(corpo);
  let res;
  try {
    res = await fetch(BANCO + caminho, opcoes);
  } catch {
    registrar(metodo, caminho, 'sem resposta');
    throw new Error('Não consegui falar com o banco em ' + BANCO + '. Confira se o Docker está rodando (docker compose ps).');
  }
  registrar(metodo, caminho, res.status);
  if (!res.ok) throw new ErroHttp(res.status, res.statusText, `${metodo} ${caminho}`);
  return res;
}

// _id vem como { "$oid": "..." }
const comId = d => ({ ...d, id: d._id?.$oid ?? d._id });
const semInternos = ({ id, _id, _etag, ...resto }) => resto;

// GET: lista todos os documentos de uma coleção (100 por página)
async function listar(caminho) {
  const todos = [];
  for (let pagina = 1; ; pagina++) {
    const res = await req('GET', `${caminho}?pagesize=100&page=${pagina}`);
    const lote = await res.json();
    todos.push(...lote.map(comId));
    if (lote.length < 100) break;
  }
  return todos;
}

// GET: busca um documento pelo id
async function buscarPorId(caminho, id) {
  const res = await req('GET', `${caminho}/${id}`);
  return comId(await res.json());
}

// POST: cria; o id gerado vem no cabeçalho Location
async function criar(caminho, doc) {
  const res = await req('POST', caminho, doc);
  return { status: res.status, id: res.headers.get('Location')?.split('/').pop() ?? null };
}

// PUT: substitui o documento inteiro
const substituir = (caminho, id, doc) => req('PUT', `${caminho}/${id}`, semInternos(doc));

// PATCH: altera só os campos enviados
const atualizarCampos = (caminho, id, campos) => req('PATCH', `${caminho}/${id}`, campos);

// DELETE: remove (204 No Content)
const excluir = (caminho, id) => req('DELETE', `${caminho}/${id}`);

// ======================================================================
// Carregamento de dados
// ======================================================================
async function conectar() {
  aviso('carregando', 'Conectando ao banco…');
  try {
    // PUT na coleção é idempotente: 201 se criou, 200 se já existia
    await Promise.all(Object.values(COL).map(c => req('PUT', c)));
    estado.digimons = await listar(COL.digimons);
    estado.duplas = await listar(COL.duplas);
    estado.conectado = true;
    estado.erroConexao = '';
    aviso('ok', `Banco conectado: ${estado.digimons.length} Digimon e ${estado.duplas.length} duplas.`);
  } catch (e) {
    estado.conectado = false;
    estado.erroConexao = mensagemErro(e);
    aviso('erro', estado.erroConexao);
  }
  renderTudo();
}

async function carregarDuplas() {
  try {
    estado.duplas = await listar(COL.duplas);
  } catch (e) {
    aviso('erro', mensagemErro(e));
  }
  renderMural();
  renderPainel();
}

// ======================================================================
// Importação: GET na Digi-API + POST no banco
// ======================================================================
async function buscarJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new ErroHttp(res.status, res.statusText, `GET ${url}`);
  return res.json();
}

const rotulo = (lista, chave) => {
  const item = Array.isArray(lista) ? lista[0] : null;
  return item ? (item[chave] ?? item.name ?? null) : null;
};

const temNivel = det => (det.levels ?? []).some(l => (l.level ?? l.name) === NIVEL_SORTEIO);

function montarDocumento(det) {
  const atributo = ATRIBUTO_API[rotulo(det.attributes, 'attribute')];
  const imagem = det.images?.[0]?.href;
  if (!atributo || !imagem) return null; // sem atributo ou sem imagem não serve ao quiz
  const descricao = det.descriptions?.find(d => /^en/i.test(d.language))?.description ?? '';
  return {
    apiId: det.id,                                           // número
    nome: det.name,
    imagem,
    nivel: temNivel(det) ? NIVEL_SORTEIO : (rotulo(det.levels, 'level') ?? 'Desconhecido'),
    atributo,                                                // Vacina | Dado | Vírus | Livre
    tipos: (det.types ?? []).map(t => t.type ?? t.name),     // lista embutida
    descricao: descricao.slice(0, 300),
    lancamento: det.releaseDate ?? null,
    origem: 'digi-api.com',                                  // campo do grupo
    criadoEm: new Date().toISOString()                       // data
  };
}

// Executa fn sobre os itens com no máximo `limite` chamadas ao mesmo tempo
async function emLotes(itens, limite, fn) {
  let proximo = 0;
  const trabalhadores = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (proximo < itens.length) await fn(itens[proximo++]);
  });
  await Promise.all(trabalhadores);
}

// GET paginado na Digi-API: todos os Digimon do nível sorteado
async function listarDaApiPorNivel() {
  const lista = [];
  for (let pagina = 0; pagina < 50; pagina++) {
    aviso('carregando', `Listando Digimon ${NIVEL_ROTULO} na Digi-API (página ${pagina + 1})…`);
    const dados = await buscarJson(`${DIGI_API}?level=${NIVEL_SORTEIO}&pageSize=100&page=${pagina}`);
    const itens = dados.content ?? [];
    lista.push(...itens);
    const totalPaginas = dados.pageable?.totalPages;
    if (!itens.length || (totalPaginas != null && pagina + 1 >= totalPaginas)) break;
  }
  return lista;
}

async function importarDigimons() {
  const botao = $('#btn-importar');
  if (botao) botao.disabled = true;
  try {
    // 1) remove do banco o que não é do nível sorteado (sobra de importações antigas)
    const antigos = estado.digimons.filter(d => d.nivel !== NIVEL_SORTEIO);
    if (antigos.length) {
      if (!confirm(`Remover ${antigos.length} Digimon que não são ${NIVEL_ROTULO} do banco e importar os ${NIVEL_ROTULO} da API?`)) {
        if (botao) botao.disabled = false;
        return;
      }
      let removidos = 0;
      await emLotes(antigos, 5, async d => {
        await excluir(COL.digimons, d.id); // DELETE: 204 No Content
        aviso('carregando', `Removendo Digimon antigos… ${++removidos} de ${antigos.length}`);
      });
      estado.digimons = estado.digimons.filter(d => d.nivel === NIVEL_SORTEIO);
    }

    // 2) lista tudo que a API tem nesse nível (GET), menos o que já está no banco
    const vistos = new Set(estado.digimons.map(d => d.apiId));
    const candidatos = (await listarDaApiPorNivel()).filter(i => !vistos.has(i.id));

    // 3) detalhe de cada um (GET) + gravação no banco (POST)
    let feitos = 0, ignorados = 0, conferidos = 0, foraDoNivel = 0, abortar = false;
    await emLotes(candidatos, 5, async item => {
      if (abortar) return;
      let det;
      try { det = await buscarJson(`${DIGI_API}/${item.id}`); } catch { ignorados++; return; }

      // trava: se o filtro da API não funcionou, não importa o catálogo inteiro
      conferidos++;
      if (!temNivel(det)) foraDoNivel++;
      if (conferidos >= 10 && foraDoNivel === conferidos) { abortar = true; return; }

      const doc = montarDocumento(det);
      if (!doc || !temNivel(det)) { ignorados++; return; } // sem atributo, sem imagem ou outro nível
      await criar(COL.digimons, doc); // POST: 201 Created
      aviso('carregando', `Importando Digimon ${NIVEL_ROTULO}… ${++feitos} de ${candidatos.length}`);
    });
    if (abortar) throw new Error(`A Digi-API não devolveu Digimon do nível "${NIVEL_SORTEIO}". Confira o filtro level= e o nome do nível no Postman.`);

    estado.digimons = await listar(COL.digimons);
    const faltando = ATRIBUTOS.filter(a => !estado.digimons.some(d => d.atributo === a));
    if (faltando.length) aviso('erro', `Importei ${feitos} Digimon ${NIVEL_ROTULO}, mas nenhum tem o atributo: ${faltando.join(', ')}.`);
    else aviso('ok', `Importação concluída: ${feitos} Digimon ${NIVEL_ROTULO} gravados (201 Created). ${ignorados} ignorados por falta de atributo, imagem ou falha na consulta.`);
  } catch (e) {
    aviso('erro', mensagemErro(e));
    estado.digimons = await listar(COL.digimons).catch(() => estado.digimons);
  }
  renderTudo();
}

// ======================================================================
// Teste (quiz)
// ======================================================================
function renderPalco() {
  const palco = $('#palco');
  const q = estado.quiz;
  if (!estado.conectado) {
    palco.innerHTML = estado.erroConexao
      ? `<div class="palco-estreito"><h2>Sem conexão com o banco</h2><p>${esc(estado.erroConexao)}</p>
         <button type="button" class="botao" data-acao="reconectar">Tentar de novo</button></div>`
      : '<p class="vazio">Conectando ao banco…</p>';
    return;
  }
  if (q.fase === 'nome') {
    const temNivelSorteio = estado.digimons.some(d => d.nivel === NIVEL_SORTEIO);
    palco.innerHTML = temNivelSorteio ? telaNome() : telaImportar(estado.digimons.length > 0);
    $('#nome')?.focus({ preventScroll: true });
  } else if (q.fase === 'pergunta') {
    palco.innerHTML = telaPergunta();
  } else {
    palco.innerHTML = telaResultado();
  }
}

function telaNome() {
  return `<div class="palco-estreito">
    <h2>Quem é você no Mundo Digital?</h2>
    <p>Responda 3 perguntas e descubra o Digimon que combina com você.</p>
    <form id="form-nome" novalidate>
      <label class="campo"><span>Seu nome</span>
        <input id="nome" maxlength="24" autocomplete="given-name" value="${esc(estado.quiz.nome)}" aria-describedby="erro-nome">
      </label>
      <p id="erro-nome" class="erro-campo" role="alert"></p>
      <button type="submit" class="botao">Começar o teste</button>
    </form>
    ${estado.digimons.some(d => d.nivel !== NIVEL_SORTEIO)
      ? `<p class="discreto">Há Digimon de outros níveis no banco. Eles não entram no sorteio.
         <button type="button" class="mini" data-acao="importar">Limpar e importar ${esc(NIVEL_ROTULO)}</button></p>`
      : ''}
  </div>`;
}

function telaImportar(temOutros = false) {
  return `<div class="palco-estreito">
    <h2>${temOutros ? 'O banco tem Digimon de outros níveis' : `O banco ainda não tem Digimon ${NIVEL_ROTULO}`}</h2>
    <p>${temOutros
      ? `Só o nível ${NIVEL_ROTULO} entra no teste. A importação remove do banco os Digimon dos outros níveis e traz todos os ${NIVEL_ROTULO} da Digi-API.`
      : `O teste sorteia o parceiro entre os Digimon ${NIVEL_ROTULO} guardados no banco. Importe todos os que a Digi-API tem nesse nível.`}
      Pode levar alguns minutos.</p>
    <button type="button" id="btn-importar" class="botao" data-acao="importar">Importar Digimon ${NIVEL_ROTULO}</button>
  </div>`;
}

function telaPergunta() {
  const q = estado.quiz;
  const p = PERGUNTAS[q.etapa];
  const pontos = PERGUNTAS.map((_, i) => `<span class="ponto ${i < q.etapa ? 'feito' : i === q.etapa ? 'atual' : ''}"></span>`).join('');
  return `<div>
    <p class="progresso"><span>Pergunta ${q.etapa + 1} de ${PERGUNTAS.length}</span><span class="pontos" aria-hidden="true">${pontos}</span></p>
    <h2>${esc(p.texto)}</h2>
    <div class="opcoes">
      ${q.opcoes.map(o => `<button type="button" class="opcao" data-acao="resposta" data-atributo="${esc(o.atributo)}">${esc(o.texto)}</button>`).join('')}
    </div>
  </div>`;
}

function telaResultado() {
  const q = estado.quiz;
  const r = q.resultado;
  return `<div class="revelacao">
    <div class="foto"><img src="${esc(r.digimon.imagem)}" alt="${esc(r.digimon.nome)}"></div>
    <div>
      <p>${esc(q.nome)}, seu atributo é ${chip(r.atributo)}</p>
      <p class="discreto">Perfil ${esc(PERFIL[r.atributo])}.</p>
      <h2>${esc(r.digimon.nome)}</h2>
      <p>Nível ${esc(r.digimon.nivel)}. Esse é o seu parceiro digital.</p>
      <p id="salvar-status" class="discreto" role="status"></p>
      <div class="acoes">
        <button type="button" class="botao" data-acao="refazer">Refazer o teste</button>
        <button type="button" class="botao secundario" data-acao="aba" data-aba="mural">Ver o mural</button>
      </div>
    </div>
  </div>`;
}

function iniciarQuiz(nome) {
  estado.quiz = { ...novoQuiz(), nome: nome.trim(), fase: 'pergunta' };
  estado.quiz.opcoes = embaralhar(PERGUNTAS[0].opcoes);
  renderPalco();
}

function responder(botao) {
  const q = estado.quiz;
  if (q.travado) return;
  q.travado = true;
  const atributo = botao.dataset.atributo;
  botao.classList.add('escolhida');
  document.querySelectorAll('.opcao').forEach(b => { b.disabled = true; });
  q.pontos[atributo]++;
  q.respostas.push(atributo);
  setTimeout(() => {
    q.travado = false;
    if (q.etapa < PERGUNTAS.length - 1) {
      q.etapa++;
      q.opcoes = embaralhar(PERGUNTAS[q.etapa].opcoes);
      renderPalco();
    } else {
      finalizarQuiz();
    }
  }, 300);
}

// Maior pontuação vence; empate no topo vira "Livre"
function calcularAtributo(pontos) {
  const ordem = ATRIBUTOS.map(a => [a, pontos[a]]).sort((x, y) => y[1] - x[1]);
  return ordem[0][1] > ordem[1][1] ? ordem[0][0] : 'Livre';
}

function finalizarQuiz() {
  const q = estado.quiz;
  const atributo = calcularAtributo(q.pontos);
  const candidatos = estado.digimons.filter(d => d.nivel === NIVEL_SORTEIO && d.atributo === atributo);
  if (!candidatos.length) {
    aviso('erro', `Não há Digimon ${NIVEL_ROTULO} com o atributo ${atributo} no banco. Reimporte os dados.`);
    estado.quiz = novoQuiz();
    renderPalco();
    return;
  }
  const digimon = candidatos[Math.floor(Math.random() * candidatos.length)];
  q.resultado = { atributo, digimon };
  q.fase = 'resultado';
  renderPalco();
  salvarDupla();
}

// POST: grava a dupla gerada
async function salvarDupla() {
  const q = estado.quiz;
  const { atributo, digimon } = q.resultado;
  const doc = {
    nomeJogador: q.nome,
    atributo,
    digimonId: digimon.id,           // referência à coleção digimons
    digimonNome: digimon.nome,       // embutidos para o mural não precisar de outro GET
    digimonImagem: digimon.imagem,
    digimonNivel: digimon.nivel,
    respostas: q.respostas,          // lista embutida
    pontuacao: q.pontos,             // objeto embutido
    favorito: false,
    criadoEm: new Date().toISOString(),
    atualizadoEm: null
  };
  const status = $('#salvar-status');
  if (status) status.textContent = 'Salvando no mural…';
  try {
    const r = await criar(COL.duplas, doc);
    q.dupla = r.id;
    if ($('#salvar-status')) $('#salvar-status').textContent = 'Dupla salva no mural (201 Created).';
    await carregarDuplas();
  } catch (e) {
    if ($('#salvar-status')) {
      $('#salvar-status').innerHTML = `${esc(mensagemErro(e))} <button type="button" class="mini" data-acao="salvar-de-novo">Tentar salvar de novo</button>`;
    }
  }
}

// ======================================================================
// Mural: listagem, busca, filtros e CRUD
// ======================================================================
function duplasFiltradas() {
  const termo = norm($('#busca').value.trim());
  const atributo = $('#filtro-atributo').value;
  const soFav = $('#so-favoritos').checked;
  return estado.duplas
    .filter(d => (!atributo || d.atributo === atributo)
      && (!soFav || d.favorito)
      && (!termo || norm(`${d.nomeJogador} ${d.digimonNome}`).includes(termo)))
    .sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
}

function renderMural() {
  const lista = duplasFiltradas();
  $('#contagem-mural').textContent = estado.duplas.length
    ? `Mostrando ${lista.length} de ${estado.duplas.length} duplas.` : '';
  $('#mural-grid').innerHTML = estado.duplas.length
    ? (lista.map(cartao).join('') || '<p class="vazio">Nenhuma dupla combina com a busca ou o filtro.</p>')
    : '<p class="vazio">O mural está vazio. Faça o teste para criar a primeira dupla.</p>';
}

function cartao(d) {
  return `<article class="cartao">
    <button type="button" class="imagem-botao" data-acao="detalhar" data-id="${esc(d.id)}" aria-label="Ver detalhes de ${esc(d.nomeJogador)} e ${esc(d.digimonNome)}">
      <img src="${esc(d.digimonImagem)}" alt="" loading="lazy">
    </button>
    <h3>${esc(d.nomeJogador)} + ${esc(d.digimonNome)}</h3>
    <div>${chip(d.atributo)}</div>
    <p class="meta">${esc(d.digimonNivel || '')} · ${esc(dataHora(d.criadoEm))}</p>
    <div class="cartao-acoes">
      <button type="button" class="mini" data-acao="favoritar" data-id="${esc(d.id)}" aria-pressed="${d.favorito ? 'true' : 'false'}">${d.favorito ? '★ Favorita' : '☆ Favoritar'}</button>
      <button type="button" class="mini" data-acao="editar" data-id="${esc(d.id)}">Editar</button>
      <button type="button" class="mini perigo" data-acao="excluir" data-id="${esc(d.id)}">Excluir</button>
    </div>
  </article>`;
}

// GET por id
async function detalhar(id) {
  aviso('carregando', 'Buscando a dupla…');
  try {
    const d = await buscarPorId(COL.duplas, id);
    $('#detalhe-corpo').innerHTML = `
      <img src="${esc(d.digimonImagem)}" alt="${esc(d.digimonNome)}">
      <h2 id="detalhe-titulo">${esc(d.nomeJogador)} + ${esc(d.digimonNome)}</h2>
      <p>${chip(d.atributo)}</p>
      <dl>
        <dt>Nível</dt><dd>${esc(d.digimonNivel || '—')}</dd>
        <dt>Respostas</dt><dd>${esc((d.respostas || []).join(', ') || '—')}</dd>
        <dt>Criada em</dt><dd>${esc(dataHora(d.criadoEm))}</dd>
        <dt>Atualizada em</dt><dd>${esc(dataHora(d.atualizadoEm))}</dd>
        <dt>Id</dt><dd>${esc(d.id)}</dd>
      </dl>`;
    $('#dlg-detalhe').showModal();
    aviso('ok', 'Dupla carregada (200 OK).');
  } catch (e) {
    aviso('erro', e.status === 404 ? 'Essa dupla não existe mais (404 Not Found). Atualize o mural.' : mensagemErro(e));
    if (e.status === 404) carregarDuplas();
  }
}

// PATCH: muda só favorito (e atualizadoEm)
async function favoritar(id) {
  const d = estado.duplas.find(x => x.id === id);
  if (!d) return;
  aviso('carregando', 'Atualizando favorito…');
  try {
    await atualizarCampos(COL.duplas, id, { favorito: !d.favorito, atualizadoEm: new Date().toISOString() });
    await carregarDuplas();
    // d ainda guarda o valor anterior ao PATCH
    aviso('ok', d.favorito ? 'Favorito removido (200 OK).' : 'Dupla marcada como favorita (200 OK).');
  } catch (e) {
    aviso('erro', mensagemErro(e));
  }
}

// DELETE com confirmação
async function removerDupla(id) {
  const d = estado.duplas.find(x => x.id === id);
  if (!d) return;
  if (!confirm(`Excluir a dupla ${d.nomeJogador} + ${d.digimonNome}? Isso não pode ser desfeito.`)) return;
  aviso('carregando', 'Excluindo…');
  try {
    await excluir(COL.duplas, id);
    await carregarDuplas();
    aviso('ok', 'Dupla excluída (204 No Content).');
  } catch (e) {
    aviso('erro', mensagemErro(e));
  }
}

// PUT: formulário de edição (substitui o documento inteiro)
function abrirEdicao(id) {
  const d = estado.duplas.find(x => x.id === id);
  if (!d) return;
  const form = $('#form-editar');
  form.dataset.id = id;
  $('#editar-nome').value = d.nomeJogador;
  $('#editar-nome').removeAttribute('aria-invalid');
  $('#editar-erro').textContent = '';

  const select = $('#editar-digimon');
  select.innerHTML = ATRIBUTOS.map(a => {
    const itens = estado.digimons.filter(x => x.atributo === a && x.nivel === NIVEL_SORTEIO).sort((x, y) => x.nome.localeCompare(y.nome));
    return itens.length
      ? `<optgroup label="${esc(a)}">${itens.map(x => `<option value="${esc(x.id)}">${esc(x.nome)}</option>`).join('')}</optgroup>`
      : '';
  }).join('');
  if ([...select.options].some(o => o.value === d.digimonId)) select.value = d.digimonId;
  $('#dlg-editar').showModal();
  $('#editar-nome').focus();
}

async function salvarEdicao(evento) {
  evento.preventDefault();
  const id = evento.target.dataset.id;
  const d = estado.duplas.find(x => x.id === id);
  const nomeInput = $('#editar-nome');
  const erro = validarNome(nomeInput.value);
  $('#editar-erro').textContent = erro;
  nomeInput.setAttribute('aria-invalid', erro ? 'true' : 'false');
  if (erro) return nomeInput.focus();

  const digimon = estado.digimons.find(x => x.id === $('#editar-digimon').value);
  if (!d || !digimon) { $('#editar-erro').textContent = 'Escolha um Digimon da lista.'; return; }

  const novo = {
    ...semInternos(d),
    nomeJogador: nomeInput.value.trim(),
    atributo: digimon.atributo,
    digimonId: digimon.id,
    digimonNome: digimon.nome,
    digimonImagem: digimon.imagem,
    digimonNivel: digimon.nivel,
    atualizadoEm: new Date().toISOString()
  };
  aviso('carregando', 'Salvando alterações…');
  try {
    await substituir(COL.duplas, id, novo);
    $('#dlg-editar').close();
    await carregarDuplas();
    aviso('ok', 'Dupla atualizada (200 OK).');
  } catch (e) {
    $('#editar-erro').textContent = mensagemErro(e);
    aviso('erro', mensagemErro(e));
  }
}

// ======================================================================
// Painel: indicadores, gráficos, ranking e agrupamento
// (tudo calculado no frontend a partir da coleção "duplas")
// ======================================================================
function contar(lista, chave) {
  const m = {};
  lista.forEach(x => { const k = chave(x); if (k != null && k !== '') m[k] = (m[k] || 0) + 1; });
  return m;
}
const ordenarContagem = m => Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const pct = (n, total) => total ? `${Math.round((n / total) * 100)}%` : '0%';

function calcularIndicadores(duplas) {
  const total = duplas.length;
  const porAtributo = contar(duplas, d => d.atributo);
  const porDigimon = contar(duplas, d => d.digimonNome);
  const porNivel = contar(duplas, d => d.digimonNivel);
  const porDia = contar(duplas, d => d.criadoEm ? new Date(d.criadoEm).toLocaleDateString('sv-SE') : null);
  const dias = Object.keys(porDia).length;
  const [atributoTop] = ordenarContagem(porAtributo);
  const [digimonTop] = ordenarContagem(porDigimon);
  const favoritas = duplas.filter(d => d.favorito).length;
  return {
    total, porAtributo, porDigimon, porNivel, porDia, atributoTop, digimonTop, favoritas,
    mediaPorDia: dias ? total / dias : 0
  };
}

function renderPainel() {
  const ind = calcularIndicadores(estado.duplas);
  const vazio = ind.total === 0;
  $('#painel-vazio').hidden = !vazio;
  $('#painel-conteudo').hidden = vazio;

  const cartoes = [
    ['Total de duplas', ind.total],
    ['Atributo mais comum', ind.atributoTop ? `${ind.atributoTop[0]} (${pct(ind.atributoTop[1], ind.total)})` : '—'],
    ['Digimon mais sorteado', ind.digimonTop ? `${ind.digimonTop[0]} (${ind.digimonTop[1]}×)` : '—'],
    ['Média de duplas por dia', ind.mediaPorDia.toFixed(1)],
    ['Duplas favoritas', `${ind.favoritas} (${pct(ind.favoritas, ind.total)})`],
    ['Digimon no banco', estado.digimons.length]
  ];
  $('#indicadores').innerHTML = cartoes.map(([r, v]) =>
    `<div class="indicador"><span class="valor">${esc(v)}</span><span class="rotulo">${esc(r)}</span></div>`).join('');
  if (vazio) return;

  // Ranking top 5
  $('#ranking').innerHTML = ordenarContagem(ind.porDigimon).slice(0, 5)
    .map(([nome, n]) => `<li>${esc(nome)} <span class="vezes">· ${n} ${n === 1 ? 'vez' : 'vezes'}</span></li>`).join('');

  // Agrupamento por atributo
  $('#agrupamento tbody').innerHTML = ATRIBUTOS.map(a =>
    `<tr><td>${chip(a)}</td><td>${ind.porAtributo[a] || 0}</td><td>${pct(ind.porAtributo[a] || 0, ind.total)}</td></tr>`).join('');

  // Gráficos (Chart.js)
  if (typeof Chart === 'undefined') {
    aviso('erro', 'Não consegui carregar o Chart.js (sem internet?). Os gráficos não serão exibidos.');
    return;
  }
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = '#1e2a1b';

  desenhar('g-atributo', 'pie', ATRIBUTOS, ATRIBUTOS.map(a => ind.porAtributo[a] || 0), ATRIBUTOS.map(a => COR_ATRIBUTO[a]));

  const catalogo = contar(estado.digimons, d => d.atributo);
  desenhar('g-nivel', 'bar', ATRIBUTOS, ATRIBUTOS.map(a => catalogo[a] || 0), ATRIBUTOS.map(a => COR_ATRIBUTO[a]), { legenda: false });

  const dias = Object.keys(ind.porDia).sort();
  desenhar('g-dia', 'line', dias.map(k => `${k.slice(8)}/${k.slice(5, 7)}`), dias.map(k => ind.porDia[k]), '#e9742b', { legenda: false });
}

function desenhar(idCanvas, tipo, rotulos, dados, cores, { legenda = true } = {}) {
  estado.graficos[idCanvas]?.destroy();
  const escalas = tipo === 'pie' ? {} : { y: { beginAtZero: true, ticks: { precision: 0 } } };
  estado.graficos[idCanvas] = new Chart($('#' + idCanvas), {
    type: tipo,
    data: {
      labels: rotulos,
      datasets: [{
        label: 'Duplas',
        data: dados,
        backgroundColor: cores,
        borderColor: tipo === 'line' ? cores : '#1e2a1b',
        borderWidth: tipo === 'line' ? 3 : 2,
        tension: 0.25
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: escalas,
      plugins: { legend: { display: legenda, position: 'bottom' } }
    }
  });
}

// ======================================================================
// Navegação, eventos e inicialização
// ======================================================================
function renderTudo() {
  renderPalco();
  renderMural();
  renderPainel();
}

function mudarAba(nome) {
  document.querySelectorAll('.aba').forEach(b => {
    if (b.dataset.aba === nome) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  ['teste', 'mural', 'painel'].forEach(a => { $(`#aba-${a}`).hidden = a !== nome; });
  if (nome !== 'teste' && estado.conectado) carregarDuplas(); // pega o que outras pessoas criaram
}

const acoes = {
  aba: b => mudarAba(b.dataset.aba),
  resposta: b => responder(b),
  refazer: () => { estado.quiz = novoQuiz(); renderPalco(); },
  'salvar-de-novo': () => salvarDupla(),
  importar: () => importarDigimons(),
  reconectar: () => conectar(),
  atualizar: () => { aviso('carregando', 'Atualizando…'); carregarDuplas().then(() => aviso('ok', 'Mural atualizado (200 OK).')); },
  detalhar: b => detalhar(b.dataset.id),
  favoritar: b => favoritar(b.dataset.id),
  editar: b => abrirEdicao(b.dataset.id),
  excluir: b => removerDupla(b.dataset.id),
  fechar: b => b.closest('dialog').close()
};

document.addEventListener('click', e => {
  const botao = e.target.closest('[data-acao]');
  if (botao) acoes[botao.dataset.acao]?.(botao);
});

document.addEventListener('submit', e => {
  if (e.target.id === 'form-nome') {
    e.preventDefault();
    const input = $('#nome');
    const erro = validarNome(input.value);
    $('#erro-nome').textContent = erro;
    input.setAttribute('aria-invalid', erro ? 'true' : 'false');
    if (erro) input.focus();
    else iniciarQuiz(input.value);
  } else if (e.target.id === 'form-editar') {
    salvarEdicao(e);
  }
});

['input', 'change'].forEach(tipo => {
  $('#busca').addEventListener(tipo, renderMural);
  $('#filtro-atributo').addEventListener(tipo, renderMural);
  $('#so-favoritos').addEventListener(tipo, renderMural);
});

conectar();