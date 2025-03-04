const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

// Carregar variáveis de ambiente
dotenv.config();

// Inicializar app Express
const app = express();
const PORT = process.env.PORT || 3000;
const MTR_URL = process.env.MTR_URL || 'http://mtr.ima.sc.gov.br/mtrservice/buscarPdfManifestoPorManifesto';

// Cache para armazenar os PDFs
const pdfCache = new Map();
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 horas em milissegundos

// Função para limpar itens expirados do cache
function limparCacheExpirado() {
  const agora = Date.now();
  for (const [chave, item] of pdfCache.entries()) {
    if (agora - item.timestamp > CACHE_DURATION) {
      pdfCache.delete(chave);
    }
  }
}

// Agendar limpeza do cache a cada hora
setInterval(limparCacheExpirado, 60 * 60 * 1000);

// Função para fazer requisição fetch usando importação dinâmica
async function fetchData(url, options) {
  const { default: fetch } = await import('node-fetch');
  return await fetch(url, options);
}

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Rota de status da API
app.get('/', (req, res) => {
  res.json({ 
    status: 'API online', 
    message: 'Use POST /api/buscar-manifesto para baixar o documento PDF'
  });
});

// Endpoint simples para verificar se a API está ativa
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    service: 'MTR PDF API',
    version: '1.0.0',
    cacheSize: pdfCache.size
  });
});

// Endpoint principal para buscar manifestos
app.post('/api/buscar-manifesto', async (req, res) => {
  try {
    // Extrair parâmetros do corpo da requisição
    const { numeroManifesto, cnpj, codigo, cnpjConsultante, numeroConsulta } = req.body;
    
    // Validar parâmetros
    if (!numeroManifesto || !cnpj || !codigo || !cnpjConsultante || !numeroConsulta) {
      return res.status(400).json({ 
        error: 'Parâmetros incompletos', 
        required: ['numeroManifesto', 'cnpj', 'codigo', 'cnpjConsultante', 'numeroConsulta'] 
      });
    }

    // Chave única para o cache
    const cacheKey = `${numeroManifesto}-${cnpj}-${codigo}-${cnpjConsultante}-${numeroConsulta}`;
    
    // Verificar se já temos no cache
    if (pdfCache.has(cacheKey)) {
      const item = pdfCache.get(cacheKey);
      const agora = Date.now();
      
      // Verificar se o cache ainda é válido
      if (agora - item.timestamp <= CACHE_DURATION) {
        console.log(`Encontrado no cache: ${cacheKey}`);
        
        // Configurar cabeçalhos para download do PDF
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=manifesto-${numeroManifesto}.pdf`);
        res.setHeader('X-Cache', 'HIT');
        
        // Enviar o PDF do cache
        return res.send(item.buffer);
      } else {
        // Cache expirado, remover
        pdfCache.delete(cacheKey);
      }
    }
    
    // Construir URL
    const url = `${MTR_URL}/${numeroManifesto}/${cnpj}/${codigo}/${cnpjConsultante}/${numeroConsulta}`;
    
    console.log(`Buscando manifesto: ${url}`);
    
    // Fazer requisição para o webservice
    const response = await fetchData(url, {
      method: 'POST',
      headers: {
        'Accept': '*/*',
        'Content-Length': '0'
      }
    });

    if (!response.ok) {
      throw new Error(`Falha na requisição: ${response.status} - ${response.statusText}`);
    }

    // Obter o PDF como arrayBuffer (em vez de buffer que está deprecado)
    const arrayBuffer = await response.arrayBuffer();
    
    // Converter o arrayBuffer para Buffer do Node.js
    const buffer = Buffer.from(arrayBuffer);

    if (!buffer || buffer.length === 0) {
      throw new Error('O arquivo retornado está vazio');
    }
    
    // Armazenar no cache
    pdfCache.set(cacheKey, {
      buffer,
      timestamp: Date.now(),
      name: `MTR_${numeroManifesto}.pdf`,
      size: buffer.length,
      type: 'application/pdf'
    });
    
    // Configurar cabeçalhos para download do PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=manifesto-${numeroManifesto}.pdf`);
    res.setHeader('X-Cache', 'MISS');
    
    // Enviar o PDF
    res.send(buffer);
    
  } catch (error) {
    console.error('Erro ao buscar manifesto:', error.message);
    
    res.status(500).json({
      error: 'Erro ao buscar manifesto',
      message: error.message
    });
  }
});

// Endpoint para visualizar o PDF no navegador
app.post('/api/visualizar-manifesto', async (req, res) => {
  try {
    // Extrair parâmetros do corpo da requisição
    const { numeroManifesto, cnpj, codigo, cnpjConsultante, numeroConsulta } = req.body;
    
    // Validar parâmetros
    if (!numeroManifesto || !cnpj || !codigo || !cnpjConsultante || !numeroConsulta) {
      return res.status(400).json({ 
        error: 'Parâmetros incompletos', 
        required: ['numeroManifesto', 'cnpj', 'codigo', 'cnpjConsultante', 'numeroConsulta'] 
      });
    }

    // Chave única para o cache
    const cacheKey = `${numeroManifesto}-${cnpj}-${codigo}-${cnpjConsultante}-${numeroConsulta}`;
    
    // Verificar se já temos no cache
    if (pdfCache.has(cacheKey)) {
      const item = pdfCache.get(cacheKey);
      const agora = Date.now();
      
      // Verificar se o cache ainda é válido
      if (agora - item.timestamp <= CACHE_DURATION) {
        console.log(`Encontrado no cache: ${cacheKey}`);
        
        // Configurar para visualização inline
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename=manifesto-${numeroManifesto}.pdf`);
        res.setHeader('X-Cache', 'HIT');
        
        // Enviar o PDF do cache
        return res.send(item.buffer);
      } else {
        // Cache expirado, remover
        pdfCache.delete(cacheKey);
      }
    }
    
    // Construir URL
    const url = `${MTR_URL}/${numeroManifesto}/${cnpj}/${codigo}/${cnpjConsultante}/${numeroConsulta}`;
    
    console.log(`Buscando manifesto para visualização: ${url}`);
    
    // Fazer requisição para o webservice
    const response = await fetchData(url, {
      method: 'POST',
      headers: {
        'Accept': '*/*',
        'Content-Length': '0'
      }
    });

    if (!response.ok) {
      throw new Error(`Falha na requisição: ${response.status} - ${response.statusText}`);
    }

    // Obter o PDF como arrayBuffer (em vez de buffer que está deprecado)
    const arrayBuffer = await response.arrayBuffer();
    
    // Converter o arrayBuffer para Buffer do Node.js
    const buffer = Buffer.from(arrayBuffer);

    if (!buffer || buffer.length === 0) {
      throw new Error('O arquivo retornado está vazio');
    }
    
    // Armazenar no cache
    pdfCache.set(cacheKey, {
      buffer,
      timestamp: Date.now(),
      name: `MTR_${numeroManifesto}.pdf`,
      size: buffer.length,
      type: 'application/pdf'
    });
    
    // Configurar para visualização inline
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=manifesto-${numeroManifesto}.pdf`);
    res.setHeader('X-Cache', 'MISS');
    
    // Enviar o PDF
    res.send(buffer);
    
  } catch (error) {
    console.error('Erro ao buscar manifesto para visualização:', error.message);
    
    res.status(500).json({
      error: 'Erro ao buscar manifesto para visualização',
      message: error.message
    });
  }
});

// Endpoints GET para compatibilidade com formulários HTML
app.get('/api/baixar-manifesto', async (req, res) => {
  // Converter query params para body e chamar o endpoint POST
  req.body = req.query;
  return app._router.handle(req, res, () => {});
});

app.get('/api/visualizar-manifesto', async (req, res) => {
  // Converter query params para body e chamar o endpoint POST
  req.body = req.query;
  return app._router.handle(req, res, () => {});
});

// Endpoint para limpar o cache
app.post('/api/limpar-cache', (req, res) => {
  const tamanhoAnterior = pdfCache.size;
  pdfCache.clear();
  res.json({
    message: 'Cache limpo com sucesso',
    itemsRemovidos: tamanhoAnterior,
    cacheAtual: pdfCache.size
  });
});

// Iniciar o servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`URL base do MTR: ${MTR_URL}`);
});