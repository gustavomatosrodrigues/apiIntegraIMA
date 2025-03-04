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
const CACHE_SIZE_LIMIT = 100 * 1024 * 1024; // Limite de 100MB para o tamanho total do cache

let cacheSize = 0; // Tamanho total atual do cache

// Função para limpar itens expirados do cache
function limparCacheExpirado() {
  const agora = Date.now();
  for (const [chave, item] of pdfCache.entries()) {
    if (agora - item.timestamp > CACHE_DURATION) {
      // Subtrair o tamanho do item do cache total antes de removê-lo
      cacheSize -= item.size;
      pdfCache.delete(chave);
    }
  }
}

// Função para limpar o cache se o tamanho total exceder o limite
function verificarLimiteCache() {
  if (cacheSize > CACHE_SIZE_LIMIT) {
    console.log(`Tamanho do cache excedido (${cacheSize / (1024 * 1024)}MB). Limpando cache...`);
    
    // Limpar cache
    pdfCache.clear();
    cacheSize = 0; // Resetar o tamanho do cache
  }
}

// Agendar limpeza do cache a cada hora
setInterval(limparCacheExpirado, 60 * 60 * 1000);

// Agendar verificação do tamanho do cache a cada 10 minutos
setInterval(verificarLimiteCache, 10 * 60 * 1000);

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

// Middleware para redirecionar qualquer rota para a versão com barra final
app.use((req, res, next) => {
  if (req.path === '/' || (req.path !== '/' && !req.path.endsWith('/') && req.path.split('/').length === 2)) {
    return res.redirect(301, req.originalUrl + '/');
  }
  next();
});

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
    cacheSize: pdfCache.size,
    cacheTotalSizeMB: cacheSize / (1024 * 1024), // Tamanho total do cache em MB
    cacheSizeLimitMB: CACHE_SIZE_LIMIT / (1024 * 1024) // Limite de cache em MB
  });
});

// Endpoint principal para buscar manifestos
app.post('/api/buscar-manifesto', async (req, res) => {
  try {
    const { numeroManifesto, cnpj, codigo, cnpjConsultante, numeroConsulta } = req.body;

    // Validar parâmetros
    if (!numeroManifesto || !cnpj || !codigo || !cnpjConsultante || !numeroConsulta) {
      return res.status(400).json({
        error: 'Parâmetros incompletos',
        required: ['numeroManifesto', 'cnpj', 'codigo', 'cnpjConsultante', 'numeroConsulta']
      });
    }

    const cacheKey = `${numeroManifesto}-${cnpj}-${codigo}-${cnpjConsultante}-${numeroConsulta}`;

    if (pdfCache.has(cacheKey)) {
      const item = pdfCache.get(cacheKey);
      const agora = Date.now();

      if (agora - item.timestamp <= CACHE_DURATION) {
        console.log(`Encontrado no cache: ${cacheKey}`);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=manifesto-${numeroManifesto}.pdf`);
        res.setHeader('X-Cache', 'HIT');

        return res.send(item.buffer);
      } else {
        // Cache expirado, remover
        cacheSize -= item.size;
        pdfCache.delete(cacheKey);
      }
    }

    // Construir URL
    const url = `${MTR_URL}/${numeroManifesto}/${cnpj}/${codigo}/${cnpjConsultante}/${numeroConsulta}`;
    console.log(`Buscando manifesto: ${url}`);

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

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (!buffer || buffer.length === 0) {
      throw new Error('O arquivo retornado está vazio');
    }

    // Verificar o tamanho total do cache antes de armazenar o novo arquivo
    if (cacheSize + buffer.length > CACHE_SIZE_LIMIT) {
      console.log(`Limite de tamanho de cache excedido ao tentar armazenar o manifesto ${numeroManifesto}. Limpando cache...`);
      pdfCache.clear();
      cacheSize = 0; // Resetando o cache
    }

    // Armazenar no cache
    pdfCache.set(cacheKey, {
      buffer,
      timestamp: Date.now(),
      name: `MTR_${numeroManifesto}.pdf`,
      size: buffer.length,
      type: 'application/pdf'
    });

    // Atualizar o tamanho total do cache
    cacheSize += buffer.length;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=manifesto-${numeroManifesto}.pdf`);
    res.setHeader('X-Cache', 'MISS');

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
    const { numeroManifesto, cnpj, codigo, cnpjConsultante, numeroConsulta } = req.body;

    // Validar parâmetros
    if (!numeroManifesto || !cnpj || !codigo || !cnpjConsultante || !numeroConsulta) {
      return res.status(400).json({
        error: 'Parâmetros incompletos',
        required: ['numeroManifesto', 'cnpj', 'codigo', 'cnpjConsultante', 'numeroConsulta']
      });
    }

    const cacheKey = `${numeroManifesto}-${cnpj}-${codigo}-${cnpjConsultante}-${numeroConsulta}`;

    if (pdfCache.has(cacheKey)) {
      const item = pdfCache.get(cacheKey);
      const agora = Date.now();

      if (agora - item.timestamp <= CACHE_DURATION) {
        console.log(`Encontrado no cache: ${cacheKey}`);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename=manifesto-${numeroManifesto}.pdf`);
        res.setHeader('X-Cache', 'HIT');

        return res.send(item.buffer);
      } else {
        // Cache expirado, remover
        cacheSize -= item.size;
        pdfCache.delete(cacheKey);
      }
    }

    // Construir URL
    const url = `${MTR_URL}/${numeroManifesto}/${cnpj}/${codigo}/${cnpjConsultante}/${numeroConsulta}`;
    console.log(`Buscando manifesto para visualização: ${url}`);

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

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (!buffer || buffer.length === 0) {
      throw new Error('O arquivo retornado está vazio');
    }

    // Verificar o tamanho total do cache antes de armazenar o novo arquivo
    if (cacheSize + buffer.length > CACHE_SIZE_LIMIT) {
      console.log(`Limite de tamanho de cache excedido ao tentar armazenar o manifesto ${numeroManifesto}. Limpando cache...`);
      pdfCache.clear();
      cacheSize = 0; // Resetando o cache
    }

    // Armazenar no cache
    pdfCache.set(cacheKey, {
      buffer,
      timestamp: Date.now(),
      name: `MTR_${numeroManifesto}.pdf`,
      size: buffer.length,
      type: 'application/pdf'
    });

    // Atualizar o tamanho total do cache
    cacheSize += buffer.length;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=manifesto-${numeroManifesto}.pdf`);
    res.setHeader('X-Cache', 'MISS');

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
  req.body = req.query;
  return app._router.handle(req, res, () => {});
});

app.get('/api/visualizar-manifesto', async (req, res) => {
  req.body = req.query;
  return app._router.handle(req, res, () => {});
});

// Endpoint para limpar o cache
app.post('/api/limpar-cache', (req, res) => {
  const tamanhoAnterior = pdfCache.size;
  pdfCache.clear();
  cacheSize = 0; // Resetando o tamanho do cache
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
