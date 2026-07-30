const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

// Middlewareapp.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// In-memory databaseconst db = {
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

// Agents (congelados conforme instrução do usuário)
const agents = {
    recepcionista: { nome: '👋 Recepcionista', descricao: 'Recebe e classifica mensagens' },
    consultor: { nome: '🚗 Consultor', descricao: 'Gera respostas com Claude' },
    secretaria: { nome: '📅 Secretária', descricao: 'Gerencia agendamentos' },
    gerente: { nome: '📊 Gerente', descricao: 'Dashboard diário', autorespond: false },
    treinador: { nome: '📚 Treinador', descricao: 'Evolui base de conhecimento', autorespond: false },
    diretor: { nome: '💼 Diretor Comercial', descricao: 'Recomendações estratégicas', autorespond: false }
};

// Marco 1: Cliente recebe resposta. Você aprova. Tudo fica registrado.// Endpoint: Receber mensagem (simulador ou webhook WhatsApp)
app.post('/api/mensagens', (req, res) => {
    const { clienteId, mensagem, origem = 'simulator' } = req.body;

           if (!clienteId || !mensagem) {
                 return res.status(400).json({ erro: 'clienteId e mensagem são obrigatórios' });
           }

           // Step 1: Recepcionista classifica  const evento = {
             id: Date.now(),
                   timestamp: new Date().toISOString(),
                   clienteId,
                   mensagem,
                   origem,
                   agente: 'recepcionista',
                   status: 'recebida'
};

  db.historico_eventos.push(evento);
  db.clientes[clienteId] = { id: clienteId, criado: new Date().toISOString(), ultima_interacao: new Date().toISOString() };

  res.json({
        sucesso: true,
        eventoId: evento.id,
        mensagem: 'Mensagem recebida. Gerando resposta...',
        metrica: {
                tempoAtePrimeiraResposta: 'calculando...'
        }
  });

  // Step 2: Gerar resposta com Claude (assíncrono)
  gerarRespostaComClaude(clienteId, mensagem, evento.id);
});

// Gerar resposta com Claude APIasync function gerarRespostaComClaude(clienteId, mensagem, eventoId) {
  try {
        const prompt = `Você é um consultor de vendas da T-Drive, uma concessionária de carros.
        Cliente pergunta: "${mensagem}"

        Responda de forma amigável e profissional, focando em agendamento de visita se apropriado.`;

    const response = await axios.post(
            'https://api.anthropic.com/v1/messages',
      {
                model: 'claude-3-5-sonnet-20241022',
                max_tokens: 1024,
                messages: [{ role: 'user', content: prompt }]
      },
      { headers: { 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' } }
          );

    const respostaGerada = response.data.content[0].text;

    // Criar resposta pendente de aprovação    const respostaPendente = {
      id: Date.now(),
              clienteId,
              mensagemOriginal: mensagem,
              respostaGerada,
              status: 'pendente_aprovacao',
              criadoEm: new Date().toISOString(),
              tempoResposta: new Date() - new Date(db.historico_eventos.find(e => e.id === eventoId).timestamp)
  };

    db.respostas_pendentes.push(respostaPendente);

    console.log(`[CONSULTOR] Resposta gerada para cliente ${clienteId}`);
} catch (erro) {
      console.error('Erro ao chamar Claude API:', erro.message);
      // Fallback: resposta genérica    const respostaPendente = {
      id: Date.now(),
              clienteId,
              mensagemOriginal: mensagem,
              respostaGerada: 'Obrigado pelo contato! Um de nossos especialistas logo responderá sua dúvida.',
              status: 'pendente_aprovacao',
              criadoEm: new Date().toISOString()
};
    db.respostas_pendentes.push(respostaPendente);
}
}

// Endpoint: Listar respostas pendentes de aprovaçãoapp.get('/api/respostas-pendentes', (req, res) => {
  const pendentes = db.respostas_pendentes.filter(r => r.status === 'pendente_aprovacao');
  res.json({
        total: pendentes.length,
        respostas: pendentes
  });
});

// Endpoint: Aprovar respostaapp.post('/api/respostas/:id/aprovar', (req, res) => {
  const { id } = req.params;
  const { respostaEditada } = req.body;

  const resposta = db.respostas_pendentes.find(r => r.id == id);
  if (!resposta) {
        return res.status(404).json({ erro: 'Resposta não encontrada' });
  }

  resposta.status = 'aprovada';
  resposta.respostaFinal = respostaEditada || resposta.respostaGerada;
  resposta.aprovadoEm = new Date().toISOString();

  // Registrar evento  db.historico_eventos.push({
    id: Date.now(),
          timestamp: new Date().toISOString(),
          clienteId: resposta.clienteId,
          agente: 'consultor',
          acao: 'resposta_aprovada',
          detalhes: { respostaPendenteId: id }
});

  res.json({ sucesso: true, resposta });
});

// Endpoint: Rejeitar respostaapp.post('/api/respostas/:id/rejeitar', (req, res) => {
  const { id } = req.params;
  const resposta = db.respostas_pendentes.find(r => r.id == id);

  if (!resposta) {
        return res.status(404).json({ erro: 'Resposta não encontrada' });
  }

  resposta.status = 'rejeitada';
  resposta.rejeitadoEm = new Date().toISOString();

  res.json({ sucesso: true, mensagem: 'Resposta rejeitada' });
});

// Endpoint: Agendar visita (Secretária)
app.post('/api/agendamentos', (req, res) => {
    const { clienteId, data, hora } = req.body;

           if (!clienteId || !data || !hora) {
                 return res.status(400).json({ erro: 'clienteId, data e hora obrigatórios' });
           }

           const agendamento = {
                 id: Date.now(),
                 clienteId,
                 data,
                 hora,
                 status: 'confirmado',
                 criadoEm: new Date().toISOString()
           };

           db.agendamentos.push(agendamento);

           db.historico_eventos.push({
                 id: Date.now(),
                 timestamp: new Date().toISOString(),
                 clienteId,
                 agente: 'secretaria',
                 acao: 'agendamento_criado',
                 detalhes: { agendamentoId: agendamento.id }
           });

           res.json({ sucesso: true, agendamento });
});

// Endpoint: Dashboard (Marco 1 - Métricas)
app.get('/api/metricas', (req, res) => {
    const totalMensagens = db.historico_eventos.filter(e => e.status === 'recebida').length;
    const respostasAprovadas = db.respostas_pendentes.filter(r => r.status === 'aprovada').length;
    const agendamentosTotal = db.agendamentos.length;

          const temposResposta = db.respostas_pendentes
      .filter(r => r.tempoResposta)
      .map(r => r.tempoResposta);

          const tempoMedio = temposResposta.length > 0 ? 
                Math.round(temposResposta.reduce((a, b) => a + b, 0) / temposResposta.length) : 0;

          res.json({
                marco1: {
                        "Métrica 1: Tempo até Primeira Resposta": `${tempoMedio}ms (Target: <5min)`,
                        "Métrica 2: Taxa de Resposta Cliente": `${totalMensagens > 0 ? Math.round((respostasAprovadas / totalMensagens) * 100) : 0}% (Target: >70%)`,
                        "Métrica 3: Taxa de Agendamento": `${totalMensagens > 0 ? Math.round((agendamentosTotal / totalMensagens) * 100) : 0}% (Target: >40%)`,
                        "Total de Mensagens": totalMensagens,
                        "Respostas Aprovadas": respostasAprovadas,
                        "Agendamentos": agendamentosTotal,
                        "Pendentes de Aprovação": db.respostas_pendentes.filter(r => r.status === 'pendente_aprovacao').length
                }
          });
});

// Endpoint: Históricoapp.get('/api/historico', (req, res) => {
  res.json({
        total: db.historico_eventos.length,
        eventos: db.historico_eventos.slice(-50) // Últimos 50  });
  });

// Health checkapp.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Iniciar servidorapp.listen(PORT, () => {
  console.log(`\n🚀 T-DRIVE VENDEDOR VIRTUAL - Sprint 1 rodando em http://localhost:${PORT}`);
  console.log(`\n📊 Painel de Aprovação: http://localhost:${PORT}`);
  console.log(`\nAPI Endpoints:`);
  console.log(`  POST /api/mensagens - Enviar mensagem`);
  console.log(`  GET /api/respostas-pendentes - Listar respostas aguardando aprovação`);
  console.log(`  POST /api/respostas/:id/aprovar - Aprovar resposta`);
  console.log(`  GET /api/metricas - Ver métricas do Marco 1`);
  console.log(`  GET /api/historico - Ver histórico de eventos\n`);
});

module.exports = app;
