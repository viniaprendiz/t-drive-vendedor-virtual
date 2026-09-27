const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY
});

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// In-memory database
const db = {
  clientes: {},
  contexto_cliente: {},
  respostas_pendentes: [],
  agendamentos: [],
  historico_eventos: [],
  base_conhecimento: [
    { pergunta: 'Qual é o preço do carro?', resposta: 'Depende do modelo e ano. Qual você está interessado?' },
    { pergunta: 'Qual é a condição do carro?', resposta: 'Nossas unidades são bem conservadas. Deseja agendar uma visita?' }
  ]
};

// IDs únicos (Date.now() colide quando dois registros são criados no mesmo ms)
let ultimoId = 0;
function novoId() {
  ultimoId = Math.max(Date.now(), ultimoId + 1);
  return ultimoId;
}

// Agents (congelados conforme instrução do usuário)
const agents = {
  recepcionista: { nome: '👋 Recepcionista', descricao: 'Recebe e classifica mensagens' },
  consultor: { nome: '🚗 Consultor', descricao: 'Gera respostas com Claude' },
  secretaria: { nome: '📅 Secretária', descricao: 'Gerencia agendamentos' },
  gerente: { nome: '📊 Gerente', descricao: 'Dashboard diário', autorespond: false },
  treinador: { nome: '📚 Treinador', descricao: 'Evolui base de conhecimento', autorespond: false },
  diretor: { nome: '💼 Diretor Comercial', descricao: 'Recomendações estratégicas', autorespond: false }
};

// Marco 1: Cliente recebe resposta. Você aprova. Tudo fica registrado.

// Endpoint: Receber mensagem (simulador ou webhook WhatsApp)
app.post('/api/mensagens', (req, res) => {
  const { clienteId, mensagem, origem = 'simulator' } = req.body;

  if (!clienteId || !mensagem) {
    return res.status(400).json({ erro: 'clienteId e mensagem são obrigatórios' });
  }

  // Step 1: Recepcionista classifica
  const evento = {
    id: novoId(),
    timestamp: new Date().toISOString(),
    clienteId,
    mensagem,
    origem,
    agente: 'recepcionista',
    status: 'recebida'
  };

  db.historico_eventos.push(evento);

  const agora = new Date().toISOString();
  const cliente = db.clientes[clienteId];
  db.clientes[clienteId] = {
    id: clienteId,
    criado: cliente ? cliente.criado : agora,
    ultima_interacao: agora
  };

  res.json({
    sucesso: true,
    eventoId: evento.id,
    mensagem: 'Mensagem recebida. Gerando resposta...',
    metrica: {
      tempoAtePrimeiraResposta: 'calculando...'
    }
  });

  // Step 2: Gerar resposta com Claude (assíncrono)
  gerarRespostaComClaude(clienteId, mensagem, evento);
});

// Gerar resposta com Claude API
async function gerarRespostaComClaude(clienteId, mensagem, evento) {
  let respostaGerada;
  try {
    const baseConhecimento = db.base_conhecimento
      .map(item => `P: ${item.pergunta}\nR: ${item.resposta}`)
      .join('\n\n');

    // Server-side fallback: se o modelo recusar, a API refaz a chamada em outro modelo.
    const response = await anthropic.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: `Você é um consultor de vendas da T-Drive, uma concessionária de carros.
Responda de forma amigável e profissional, em português, focando em agendamento de visita se apropriado.
Sua resposta será revisada por um humano antes de ser enviada ao cliente pelo WhatsApp, então escreva apenas o texto da mensagem.

Base de conhecimento:
${baseConhecimento}`,
      messages: [{ role: 'user', content: mensagem }]
    });

    if (response.stop_reason === 'refusal') {
      throw new Error('Claude recusou a solicitação');
    }

    respostaGerada = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();

    if (!respostaGerada) {
      throw new Error('Resposta vazia');
    }

    console.log(`[CONSULTOR] Resposta gerada para cliente ${clienteId}`);
  } catch (erro) {
    console.error('Erro ao chamar Claude API:', erro.message);
    // Fallback: resposta genérica
    respostaGerada = 'Obrigado pelo contato! Um de nossos especialistas logo responderá sua dúvida.';
  }

  // Criar resposta pendente de aprovação
  db.respostas_pendentes.push({
    id: novoId(),
    clienteId,
    eventoId: evento.id,
    mensagemOriginal: mensagem,
    respostaGerada,
    status: 'pendente_aprovacao',
    criadoEm: new Date().toISOString(),
    tempoResposta: Date.now() - new Date(evento.timestamp).getTime()
  });
}

// Endpoint: Listar respostas pendentes de aprovação
app.get('/api/respostas-pendentes', (req, res) => {
  const pendentes = db.respostas_pendentes.filter(r => r.status === 'pendente_aprovacao');
  res.json({
    total: pendentes.length,
    respostas: pendentes
  });
});

// Endpoint: Aprovar resposta
app.post('/api/respostas/:id/aprovar', (req, res) => {
  const { id } = req.params;
  const { respostaEditada } = req.body;

  const resposta = db.respostas_pendentes.find(r => r.id == id);
  if (!resposta) {
    return res.status(404).json({ erro: 'Resposta não encontrada' });
  }
  if (resposta.status !== 'pendente_aprovacao') {
    return res.status(409).json({ erro: `Resposta já está ${resposta.status}` });
  }

  resposta.status = 'aprovada';
  resposta.respostaFinal = respostaEditada || resposta.respostaGerada;
  resposta.editada = Boolean(respostaEditada) && respostaEditada !== resposta.respostaGerada;
  resposta.aprovadoEm = new Date().toISOString();

  // Registrar evento
  db.historico_eventos.push({
    id: novoId(),
    timestamp: new Date().toISOString(),
    clienteId: resposta.clienteId,
    agente: 'consultor',
    acao: 'resposta_aprovada',
    detalhes: { respostaPendenteId: resposta.id, editada: resposta.editada }
  });

  res.json({ sucesso: true, resposta });
});

// Endpoint: Rejeitar resposta
app.post('/api/respostas/:id/rejeitar', (req, res) => {
  const { id } = req.params;
  const resposta = db.respostas_pendentes.find(r => r.id == id);

  if (!resposta) {
    return res.status(404).json({ erro: 'Resposta não encontrada' });
  }
  if (resposta.status !== 'pendente_aprovacao') {
    return res.status(409).json({ erro: `Resposta já está ${resposta.status}` });
  }

  resposta.status = 'rejeitada';
  resposta.rejeitadoEm = new Date().toISOString();

  db.historico_eventos.push({
    id: novoId(),
    timestamp: new Date().toISOString(),
    clienteId: resposta.clienteId,
    agente: 'consultor',
    acao: 'resposta_rejeitada',
    detalhes: { respostaPendenteId: resposta.id }
  });

  res.json({ sucesso: true, mensagem: 'Resposta rejeitada' });
});

// Endpoint: Agendar visita (Secretária)
app.post('/api/agendamentos', (req, res) => {
  const { clienteId, data, hora } = req.body;

  if (!clienteId || !data || !hora) {
    return res.status(400).json({ erro: 'clienteId, data e hora obrigatórios' });
  }

  const agendamento = {
    id: novoId(),
    clienteId,
    data,
    hora,
    status: 'confirmado',
    criadoEm: new Date().toISOString()
  };

  db.agendamentos.push(agendamento);

  db.historico_eventos.push({
    id: novoId(),
    timestamp: new Date().toISOString(),
    clienteId,
    agente: 'secretaria',
    acao: 'agendamento_criado',
    detalhes: { agendamentoId: agendamento.id }
  });

  res.json({ sucesso: true, agendamento });
});

// Endpoint: Listar agendamentos
app.get('/api/agendamentos', (req, res) => {
  res.json({ total: db.agendamentos.length, agendamentos: db.agendamentos });
});

// Endpoint: Agentes
app.get('/api/agentes', (req, res) => {
  res.json(agents);
});

// Endpoint: Dashboard (Marco 1 - Métricas)
app.get('/api/metricas', (req, res) => {
  const totalMensagens = db.historico_eventos.filter(e => e.status === 'recebida').length;
  const respostasAprovadas = db.respostas_pendentes.filter(r => r.status === 'aprovada').length;
  const agendamentosTotal = db.agendamentos.length;

  const temposResposta = db.respostas_pendentes
    .filter(r => r.tempoResposta)
    .map(r => r.tempoResposta);

  const tempoMedio = temposResposta.length > 0
    ? Math.round(temposResposta.reduce((a, b) => a + b, 0) / temposResposta.length)
    : 0;

  res.json({
    marco1: {
      'Métrica 1: Tempo até Primeira Resposta': `${tempoMedio}ms (Target: <5min)`,
      'Métrica 2: Taxa de Resposta Cliente': `${totalMensagens > 0 ? Math.round((respostasAprovadas / totalMensagens) * 100) : 0}% (Target: >70%)`,
      'Métrica 3: Taxa de Agendamento': `${totalMensagens > 0 ? Math.round((agendamentosTotal / totalMensagens) * 100) : 0}% (Target: >40%)`,
      'Total de Mensagens': totalMensagens,
      'Respostas Aprovadas': respostasAprovadas,
      'Agendamentos': agendamentosTotal,
      'Pendentes de Aprovação': db.respostas_pendentes.filter(r => r.status === 'pendente_aprovacao').length
    }
  });
});

// Endpoint: Histórico
app.get('/api/historico', (req, res) => {
  res.json({
    total: db.historico_eventos.length,
    eventos: db.historico_eventos.slice(-50) // Últimos 50
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Iniciar servidor
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🚀 T-DRIVE VENDEDOR VIRTUAL - Sprint 1 rodando em http://localhost:${PORT}`);
    console.log(`\n📊 Painel de Aprovação: http://localhost:${PORT}`);
    console.log(`\nAPI Endpoints:`);
    console.log(`  POST /api/mensagens - Enviar mensagem`);
    console.log(`  GET /api/respostas-pendentes - Listar respostas aguardando aprovação`);
    console.log(`  POST /api/respostas/:id/aprovar - Aprovar resposta`);
    console.log(`  POST /api/respostas/:id/rejeitar - Rejeitar resposta`);
    console.log(`  POST /api/agendamentos - Agendar visita`);
    console.log(`  GET /api/metricas - Ver métricas do Marco 1`);
    console.log(`  GET /api/historico - Ver histórico de eventos\n`);
    if (!process.env.CLAUDE_API_KEY && !process.env.ANTHROPIC_API_KEY) {
      console.warn('⚠️  CLAUDE_API_KEY não definida: respostas usarão o texto genérico de fallback.\n');
    }
  });
}

module.exports = app;
