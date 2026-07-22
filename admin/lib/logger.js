const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {
    // Best effort. Logging should never crash the app.
  }
}

function dayStamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function sanitizeValue(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeValue(v, depth + 1);
    return out;
  }
  return value;
}

function writeJsonLine(prefix, payload) {
  ensureDir(LOG_DIR);
  const file = path.join(LOG_DIR, `${prefix}-${dayStamp()}.log`);
  const line = `${JSON.stringify(payload)}\n`;
  try {
    fs.appendFileSync(file, line, 'utf8');
  } catch {
    // Swallow logging failures to avoid breaking request flow.
  }
}

function base(level, message, meta = {}) {
  const payload = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...sanitizeValue(meta)
  };
  writeJsonLine('app', payload);
  return payload;
}

const logger = {
  info(message, meta = {}) {
    return base('info', message, meta);
  },
  warn(message, meta = {}) {
    return base('warn', message, meta);
  },
  error(message, meta = {}) {
    return base('error', message, meta);
  }
};

function audit(event, data = {}) {
  const payload = {
    event,
    at: new Date().toISOString(),
    ...sanitizeValue(data)
  };
  writeJsonLine('audit', payload);
  return payload;
}

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const user = req?.session?.user || null;
    logger.info('request', {
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      ms,
      ip: req.ip,
      userId: user && user.id ? user.id : null,
      userEmail: user && user.email ? user.email : null
    });
  });
  next();
}

function tailFile(filePath, maxLines = 200) {
  const safeMax = Number.isFinite(Number(maxLines)) ? Math.max(1, Math.min(2000, Number(maxLines))) : 200;
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.slice(-safeMax).join('\n');
}

module.exports = {
  logger,
  audit,
  requestLogger,
  LOG_DIR,
  tailFile
};
