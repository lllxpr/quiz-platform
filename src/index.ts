// Quiz App — standalone Cloudflare Worker
// Exports: default fetch handler + QuizRoom and ReactionRoom Durable Objects

// @ts-ignore — pure JS DO classes
export { QuizRoom } from './room.mjs';
export { ReactionRoom } from './reaction-room.mjs';

import ADMIN_HTML from './admin.html?raw';
import SETUP_HTML from './setup.html?raw';
import SCHEMA from '../schema.sql?raw';
import {initializeSchema,siteSettings,checkAuth,accountRoute} from './auth.mjs';
import {sitePage} from './site-page.mjs';
import PLAYER_HTML from './player.html?raw';
import REACTION_HTML from './reaction.html?raw';

interface Env {
  QUIZ_DB: D1Database;
  QUIZ_ROOM: DurableObjectNamespace;
  REACTION_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function html(content: string) {
  return new Response(content, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Quiz-Release':'quiz-platform-setup-v1',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
}

// ── Main handler ──
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    await initializeSchema(env.QUIZ_DB, SCHEMA);
    const account = await accountRoute(request, env);
    if(account) return account;
    const settings = await siteSettings(env.QUIZ_DB);
    if(path === '/setup') return settings ? Response.redirect(url.origin+'/admin',303) : html(SETUP_HTML);
    if(!settings) return path.startsWith('/api/') ? json({error:'Setup required'},503) : Response.redirect(url.origin+'/setup',303);
    if(request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({error:'Origin not allowed'},403);
    const page = (content: string) => html(sitePage(content, settings));


    if (path.startsWith('/music/')) return env.ASSETS.fetch(request);
    if (path === '/api/quiz/active') {
      const room = env.QUIZ_ROOM.get(env.QUIZ_ROOM.idFromName('quiz-title-v1'));
      if(request.method==='POST'){
        if(!await checkAuth(request,env))return json({error:'Unauthorized'},401);
        return room.fetch(new Request('https://quiz-room/metadata',{method:'POST',body:await request.text()}));
      }
      return room.fetch(new Request('https://quiz-room/metadata'));
    }

    // ── WebSocket ──
    if (path === '/api/reaction/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const id = env.REACTION_ROOM.idFromName('reactions');
      return env.REACTION_ROOM.get(id).fetch(request);
    }

    if (path === '/api/quiz/ws') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const role = url.searchParams.get('role');
      if (role === 'admin') {
        if (!await checkAuth(request, env)) {
          const pair = new WebSocketPair();
          const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
          server.accept();
          server.close(4001, 'Unauthorized');
          return new Response(null, { status: 101, webSocket: client } as any);
        }
      }
      const id = env.QUIZ_ROOM.idFromName('main-room');
      const room = env.QUIZ_ROOM.get(id);
      return room.fetch(request);
    }

    // ── API Routes ──

    // GET /api/quiz/quizzes
    if (path === '/api/quiz/quizzes' && request.method === 'GET') {
      if (!await checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
      try {
        const { results } = await env.QUIZ_DB.prepare(
          `SELECT q.*, (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.id) as question_count FROM quizzes q ORDER BY q.id DESC`
        ).all();
        return json({ success: true, data: results });
      } catch {
        return json({ error: 'Query failed' }, 500);
      }
    }

    // POST /api/quiz/quizzes
    if (path === '/api/quiz/quizzes' && request.method === 'POST') {
      if (!await checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
      try {
        const { name } = await request.json() as { name: string };
        if (!name) return json({ error: 'Name required' }, 400);
        const result = await env.QUIZ_DB.prepare('INSERT INTO quizzes (name) VALUES (?)').bind(name).run();
        return json({ success: true, id: result.meta.last_row_id });
      } catch {
        return json({ error: 'Create failed' }, 500);
      }
    }

    // PUT /api/quiz/quizzes/:id
    const quizPut = path.match(/^\/api\/quiz\/quizzes\/(\d+)$/);
    if (quizPut && request.method === 'PUT') {
      if (!await checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
      try {
        const id = quizPut[1];
        const { name } = await request.json() as { name: string };
        if (!name) return json({ error: 'Name required' }, 400);
        await env.QUIZ_DB.prepare('UPDATE quizzes SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(name, id).run();
        return json({ success: true });
      } catch {
        return json({ error: 'Update failed' }, 500);
      }
    }

    // DELETE /api/quiz/quizzes/:id
    const quizDel = path.match(/^\/api\/quiz\/quizzes\/(\d+)$/);
    if (quizDel && request.method === 'DELETE') {
      if (!await checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
      try {
        const id = quizDel[1];
        await env.QUIZ_DB.prepare('DELETE FROM quiz_questions WHERE quiz_id = ?').bind(id).run();
        await env.QUIZ_DB.prepare('DELETE FROM quizzes WHERE id = ?').bind(id).run();
        return json({ success: true });
      } catch {
        return json({ error: 'Delete failed' }, 500);
      }
    }

    // GET /api/quiz/quizzes/:id/questions
    const questionsGet = path.match(/^\/api\/quiz\/quizzes\/(\d+)\/questions$/);
    if (questionsGet && request.method === 'GET') {
      if (!await checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
      try {
        const quizId = questionsGet[1];
        const { results } = await env.QUIZ_DB.prepare(
          'SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY sort_order ASC, id ASC'
        ).bind(quizId).all();
        return json({ success: true, data: results });
      } catch {
        return json({ error: 'Query failed' }, 500);
      }
    }

    // POST /api/quiz/quizzes/:id/questions
    const questionsPost = path.match(/^\/api\/quiz\/quizzes\/(\d+)\/questions$/);
    if (questionsPost && request.method === 'POST') {
      if (!await checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
      try {
        const quizId = questionsPost[1];
        const { question, options, answer, category } = await request.json() as any;
        if (!question || !options || options.length !== 4 || answer === undefined) {
          return json({ error: 'Incomplete question data' }, 400);
        }
        const maxRow: any = await env.QUIZ_DB.prepare('SELECT COALESCE(MAX(sort_order),0)+1 as next FROM quiz_questions WHERE quiz_id = ?').bind(quizId).first();
        const sortOrder = maxRow?.next || 1;
        const result = await env.QUIZ_DB.prepare(
          'INSERT INTO quiz_questions (quiz_id, question, options, answer, category, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(quizId, question, JSON.stringify(options), answer, category || '', sortOrder).run();
        return json({ success: true, id: result.meta.last_row_id });
      } catch {
        return json({ error: 'Add failed' }, 500);
      }
    }

    // PUT /api/quiz/questions/:id
    const qPut = path.match(/^\/api\/quiz\/questions\/(\d+)$/);
    if (qPut && request.method === 'PUT') {
      if (!await checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
      try {
        const id = qPut[1];
        const { question, options, answer, category, sort_order } = await request.json() as any;
        if (!question || !options || options.length !== 4 || answer === undefined) {
          return json({ error: 'Incomplete question data' }, 400);
        }
        await env.QUIZ_DB.prepare(
          'UPDATE quiz_questions SET question = ?, options = ?, answer = ?, category = ?, sort_order = ? WHERE id = ?'
        ).bind(question, JSON.stringify(options), answer, category || '', sort_order || 0, id).run();
        return json({ success: true });
      } catch {
        return json({ error: 'Update failed' }, 500);
      }
    }

    // DELETE /api/quiz/questions/:id
    const qDel = path.match(/^\/api\/quiz\/questions\/(\d+)$/);
    if (qDel && request.method === 'DELETE') {
      if (!await checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
      try {
        const id = qDel[1];
        await env.QUIZ_DB.prepare('DELETE FROM quiz_questions WHERE id = ?').bind(id).run();
        return json({ success: true });
      } catch {
        return json({ error: 'Delete failed' }, 500);
      }
    }

    // POST /api/quiz/save
    if (path === '/api/quiz/save' && request.method === 'POST') {
      if (!await checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
      try {
        const { results, playerCount } = await request.json() as any;
        if (!results || !Array.isArray(results)) return json({ error: 'Invalid data' }, 400);
        const now = new Date();
        const gmt8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
        const playedAt = gmt8.getFullYear() + '-' +
          String(gmt8.getMonth() + 1).padStart(2, '0') + '-' +
          String(gmt8.getDate()).padStart(2, '0') + ' ' +
          String(gmt8.getHours()).padStart(2, '0') + ':' +
          String(gmt8.getMinutes()).padStart(2, '0');
        await env.QUIZ_DB.prepare(
          'INSERT INTO quiz_games (played_at, results, player_count) VALUES (?, ?, ?)'
        ).bind(playedAt, JSON.stringify(results), playerCount || results.length).run();
        return json({ success: true });
      } catch {
        return json({ error: 'Save failed' }, 500);
      }
    }

    // GET /api/quiz/history
    if (path === '/api/quiz/history' && request.method === 'GET') {
      if (!await checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
      try {
        const { results } = await env.QUIZ_DB.prepare('SELECT * FROM quiz_games ORDER BY id DESC LIMIT 50').all();
        return json({ success: true, data: results });
      } catch {
        return json({ error: 'Query failed' }, 500);
      }
    }

    // POST /api/quiz/delete
    if (path === '/api/quiz/delete' && request.method === 'POST') {
      if (!await checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
      try {
        const { id } = await request.json() as { id: number };
        if (!id) return json({ error: 'Missing ID' }, 400);
        await env.QUIZ_DB.prepare('DELETE FROM quiz_games WHERE id = ?').bind(id).run();
        return json({ success: true });
      } catch {
        return json({ error: 'Delete failed' }, 500);
      }
    }

    // ── HTML Pages ──
    if (path === '/reaction') {
      return page(REACTION_HTML);
    }

    if (path === '/admin') {
      return page(ADMIN_HTML);
    }

    if (path === '/' || path === '/play') {
      return page(PLAYER_HTML);
    }

    return new Response('Not Found', { status: 404 });
  },
};
