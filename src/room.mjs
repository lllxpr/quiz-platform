// QuizRoom Durable Object — real-time quiz game engine
// This .mjs version is used by the post-build script to inject into the worker entry

function broadcast(game, msg, includeAdmin = true) {
  const data = JSON.stringify(msg);
  for (const player of game.players.values()) {
    if (player.ws) try { player.ws.send(data); } catch {}
  }
  if (includeAdmin && game.adminWs) {
    try { game.adminWs.send(data); } catch {}
  }
}

function getLeaderboard(game, top = 5) {
  return Array.from(game.players.entries())
    .filter(([id, p]) => p.score > 0 || p.ws || p.isAI)
    .map(([id, p]) => ({ id, nickname: p.nickname, score: p.score, streak: p.streak || 0, isAI: !!p.isAI, aiTier: p.aiTier }))
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

function getLobbyPlayers(game) {
  return Array.from(game.players.entries())
    .filter(([, player]) => player.ws || player.isAI)
    .map(([id, player]) => ({ id, nickname: player.nickname, isAI: !!player.isAI, aiTier: player.aiTier }));
}

function getAnswerStats(game, questionIndex) {
  const counts = [0, 0, 0, 0];
  for (const player of game.players.values()) {
    const ans = player.answers.get(questionIndex);
    if (ans !== undefined) counts[ans.option]++;
  }
  return counts;
}

function getTeamStats(game, questionIndex, correctAnswer) {
  const summarize = (isAI) => {
    const team = Array.from(game.players.values()).filter(player => !!player.isAI === isAI);
    const answers = team.map(player => ({ player, answer: player.answers.get(questionIndex) })).filter(item => item.answer);
    const correct = answers.filter(item => item.answer.option === correctAnswer);
    const fastest = correct.sort((a, b) => a.answer.time - b.answer.time)[0];
    return {
      players: team.length,
      answered: answers.length,
      correct: correct.length,
      accuracy: answers.length ? Math.round(correct.length / answers.length * 100) : 0,
      fastest: fastest ? { nickname: fastest.player.nickname, time: fastest.answer.time } : null,
    };
  };
  return { human: summarize(false), ai: summarize(true) };
}

function answeredCount(game, questionIndex) {
  let count = 0;
  for (const player of game.players.values()) {
    if (player.answers.has(questionIndex)) count++;
  }
  return count;
}

export class QuizRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.quizMeta = { quizId: null, title: 'Quiz Platform' };
    this.metadataReady = state.blockConcurrencyWhile(async () => { const configured = await env.QUIZ_DB.prepare('SELECT site_name FROM app_settings WHERE id=1').first(); this.quizMeta = await state.storage.get('selectedQuiz') || {quizId:null,title:configured?.site_name || 'Quiz Platform'}; });
    this.game = {
      state: 'lobby',
      currentQuestion: -1,
      questionStartTime: 0,
      countdownStartedAt: 0,
      questionDuration: 20000,
      players: new Map(),
      adminWs: null,
      questions: [],
      finalLeaderboard: null,
    };
    this.timerAbort = null;
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      await this.metadataReady;
      if(url.pathname === '/metadata') {
        if(request.method==='POST'){const meta=await request.json();if(!await this._selectQuiz(meta.quizId))return new Response('Invalid quiz',{status:400});}
        return Response.json(this.quizMeta, {headers:{'Cache-Control':'no-store'}});
      }
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      const role = url.searchParams.get('role');
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      if (role === 'admin') {
        this._handleAdmin(server);
      } else {
        this._handlePlayer(server);
      }

      return new Response(null, { status: 101, webSocket: client });
    } catch (err) {
      console.error('QuizRoom fetch error:', err);
      return new Response('DO error: ' + err.message, { status: 500 });
    }
  }

  _handleAdmin(ws) {
    this.game.adminWs = ws;
    const stateMsg = {
      type: 'state',
      quizId: this.quizMeta.quizId, quizTitle: this.quizMeta.title,
      state: this.game.state,
      currentQuestion: this.game.currentQuestion,
      totalQuestions: this.game.questions.length,
      playerCount: this._connectedPlayerCount(),
      players: Array.from(this.game.players.entries()).map(([id, p]) => ({ id, nickname: p.nickname, score: p.score, streak: p.streak || 0, isAI: !!p.isAI, aiTier: p.aiTier })),
    };
    if (this.game.state === 'finished' && this.game.finalLeaderboard) {
      stateMsg.leaderboard = this.game.finalLeaderboard;
    }
    ws.send(JSON.stringify(stateMsg));

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        Promise.resolve(this._handleAdminMessage(msg)).catch(err=>{try{ws.send(JSON.stringify({type:"error",message:err.message}))}catch{}});
      } catch {}
    });

    ws.addEventListener('close', () => {
      if (this.game.adminWs === ws) this.game.adminWs = null;
    });
    ws.addEventListener('error', () => {});
  }

  _handlePlayer(ws) {
    ws.send(JSON.stringify({type:'quiz_selected',...this.quizMeta}));
    let playerId = null;

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'join') {
          // Try to reconnect existing player by nickname during active game
          let reconnected = false;
          const requestedId = typeof msg.playerId === 'string' ? msg.playerId : '';
          const requestedPlayer = requestedId ? this.game.players.get(requestedId) : null;
          if (requestedPlayer && !requestedPlayer.isAI) {
            playerId = requestedId;
            requestedPlayer.nickname = msg.nickname || requestedPlayer.nickname;
            requestedPlayer.ws = ws;
            reconnected = true;
          } else if (this.game.state !== 'lobby' && msg.nickname) {
            for (const [existingId, p] of this.game.players.entries()) {
              if (p.nickname === msg.nickname && !p.ws && !p.isAI) {
                playerId = existingId;
                p.ws = ws;
                reconnected = true;
                break;
              }
            }
          }
          if (!reconnected) {
            playerId = crypto.randomUUID();
            this.game.players.set(playerId, {
              nickname: msg.nickname,
              score: 0,
              streak: 0,
              answers: new Map(),
              ws,
            });
          }
          const player = this.game.players.get(playerId);
          ws.send(JSON.stringify({ type: 'joined', playerId, state: this.game.state, score: player?.score || 0, streak: player?.streak || 0 }));

          if (this.game.adminWs) {
            this.game.adminWs.send(JSON.stringify({
              type: 'player_joined',
              playerId,
              nickname: msg.nickname,
              playerCount: this._connectedPlayerCount(),
              players: Array.from(this.game.players.entries()).map(([id, p]) => ({ id, nickname: p.nickname, score: p.score, streak: p.streak || 0, isAI: !!p.isAI, aiTier: p.aiTier })),
            }));
          }
          broadcast(this.game, { type: 'lobby_players', players: getLobbyPlayers(this.game) }, false);

          if (this.game.state === 'countdown') {
            ws.send(JSON.stringify({ type: 'countdown', seconds: Math.max(0, 3 - Math.floor((Date.now() - this.game.countdownStartedAt) / 1000)) }));
          }

          if (this.game.state === 'question' && this.game.questions.length > 0) {
            const q = this.game.questions[this.game.currentQuestion];
            ws.send(JSON.stringify({
              type: 'question',
              index: this.game.currentQuestion,
              total: this.game.questions.length,
              question: q.question,
              options: q.options,
              duration: this.game.questionDuration,
              remaining: Math.max(0, this.game.questionDuration - (Date.now() - this.game.questionStartTime)),
            }));
          }
        }
        if (msg.type === 'answer' && playerId) {
          this._handleAnswer(playerId, msg.option);
        }
      } catch {}
    });

    ws.addEventListener('close', () => {
      if (playerId) {
        if (this.game.state === 'lobby') {
          // In lobby, fully remove the player
          this.game.players.delete(playerId);
        } else {
          // During active game, keep player data but mark disconnected
          const player = this.game.players.get(playerId);
          if (player) player.ws = null;
        }
        try {
          if (this.game.adminWs) {
            this.game.adminWs.send(JSON.stringify({
              type: 'player_left',
              playerId,
              playerCount: this._connectedPlayerCount(),
            }));
          }
        } catch {}
        broadcast(this.game, { type: 'lobby_players', players: getLobbyPlayers(this.game) }, false);
      }
    });
    ws.addEventListener('error', () => {});
  }

  async _selectQuiz(quizId) {
    if(this.game.state !== 'lobby') return false;
    const id=Number(quizId);
    if(!Number.isInteger(id)||id<1)return false;
    const quiz=await this.env.QUIZ_DB.prepare('SELECT id,name FROM quizzes WHERE id=?').bind(id).first();
    if(!quiz||this.game.state !== 'lobby')return false;
    this.quizMeta={quizId:quiz.id,title:String(quiz.name)};
    await this.state.storage.put('selectedQuiz',this.quizMeta);
    broadcast(this.game,{type:'quiz_selected',...this.quizMeta});
    return true;
  }

  async _handleAdminMessage(msg) {
    switch (msg.type) {
      case 'select_quiz':
        await this._selectQuiz(msg.quizId);
        break;
      case 'add_ai_players':
        this._addAiPlayers(msg.tier || 'average', msg.count || 3);
        break;
      case 'remove_ai_players':
        this._removeAiPlayers();
        break;
      case 'start_game':
        if(msg.quizId)await this._selectQuiz(msg.quizId);
        if (msg.questions && Array.isArray(msg.questions) && msg.questions.length > 0) {
          this.game.questions = msg.questions;
        }
        this._startGame();
        break;
      case 'next_question':
        this._nextQuestion();
        break;
      case 'reset':
        this._resetGame();
        break;
    }
  }

  _addAiPlayers(tier, count) {
    const AI_NAMES = ['Alex','Sam','Jordan','Taylor','Morgan','Casey','Riley','Quinn','Avery','Jamie','Dakota','Skyler','Reese','Parker','Drew','Blake','Charlie','Frankie','Hayden','Robin','Cameron','Sage','Kai','Emery','Rowan','Finley','Logan','Harley','Phoenix','River'];
    const usedNames = new Set();
    for (const p of this.game.players.values()) usedNames.add(p.nickname);
    const tiers = { expert: 0.80, average: 0.60, newbie: 0.40 };
    const accuracy = tiers[tier] || 0.40;
    const labels = { expert: 'Expert', average: 'Balanced', newbie: 'Casual' };
    const label = labels[tier] || labels.newbie;
    const available = AI_NAMES.filter(n => !usedNames.has('AI · ' + n) && !usedNames.has(n + ' · ' + label));
    for (let i = available.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [available[i], available[j]] = [available[j], available[i]];
    }
    const added = [];
    for (let i = 0; i < count && i < available.length; i++) {
      const id = 'ai-' + crypto.randomUUID().slice(0, 8);
      const nickname = 'AI · ' + available[i];
      this.game.players.set(id, {
        nickname,
        score: 0,
        streak: 0,
        answers: new Map(),
        ws: null,
        isAI: true,
        aiAccuracy: accuracy,
        aiTier: tier,
      });
      added.push({ id, nickname });
    }
    if (this.game.adminWs) {
      this.game.adminWs.send(JSON.stringify({
        type: 'ai_players_added',
        players: added,
        playerCount: this.game.players.size,
        allPlayers: Array.from(this.game.players.entries()).map(([id, p]) => ({ id, nickname: p.nickname, score: p.score, streak: p.streak || 0, isAI: !!p.isAI, aiTier: p.aiTier })),
      }));
    }
    broadcast(this.game, { type: 'lobby_players', players: getLobbyPlayers(this.game) }, false);
  }

  _removeAiPlayers() {
    if (['countdown', 'question', 'reveal'].includes(this.game.state)) return;
    for (const [id, player] of this.game.players) if (player.isAI) this.game.players.delete(id);
    if (this.game.adminWs) {
      this.game.adminWs.send(JSON.stringify({
        type: 'ai_players_removed',
        playerCount: this.game.players.size,
        allPlayers: Array.from(this.game.players.entries()).map(([id, p]) => ({ id, nickname: p.nickname, score: p.score, streak: p.streak || 0, isAI: !!p.isAI, aiTier: p.aiTier })),
      }));
    }
    broadcast(this.game, { type: 'lobby_players', players: getLobbyPlayers(this.game) }, false);
  }

  _startGame() {
    if (this.game.questions.length === 0 || this.game.state === 'countdown') return;
    if (this.timerAbort) this.timerAbort.abort();
    this.game.state = 'countdown';
    this.game.currentQuestion = -1;
    this.game.countdownStartedAt = Date.now();
    for (const player of this.game.players.values()) {
      player.score = 0;
      player.streak = 0;
      player.answers = new Map();
    }
    broadcast(this.game, { type: 'countdown', seconds: 3 });
    this.timerAbort = new AbortController();
    const controller = this.timerAbort;
    setTimeout(() => {
      if (!controller.signal.aborted && this.game.state === 'countdown') this._nextQuestion();
    }, 3200);
  }

  _nextQuestion() {
    if(this.game.state === 'finished') return;
    if (this.game.currentQuestion < this.game.questions.length - 1) {
      this.game.currentQuestion++;
      this.game.state = 'question';
      this._sendQuestion();
    } else {
      this._finishGame();
    }
  }

  _sendQuestion() {
    const q = this.game.questions[this.game.currentQuestion];
    this.game.questionStartTime = Date.now();
    if (this.timerAbort) this.timerAbort.abort();
    this.timerAbort = new AbortController();

    broadcast(this.game, {
      type: 'question',
      index: this.game.currentQuestion,
      total: this.game.questions.length,
      question: q.question,
      options: q.options,
      duration: this.game.questionDuration,
      remaining: this.game.questionDuration,
    });

    // Schedule AI player answers
    this._scheduleAiAnswers();

    const controller = this.timerAbort;
    setTimeout(() => {
      try {
        if (!controller.signal.aborted) this._revealAnswer();
      } catch (err) {
        console.error('Timer reveal error:', err);
      }
    }, this.game.questionDuration);
  }

  _scheduleAiAnswers() {
    const qi = this.game.currentQuestion;
    const q = this.game.questions[qi];
    if (!q) return;
    for (const [pid, player] of this.game.players.entries()) {
      if (!player.isAI) continue;
      const ranges = { expert: [1000, 3000], average: [2000, 6000], newbie: [3000, 9000] };
      const [minDelay, maxDelay] = ranges[player.aiTier] || ranges.newbie;
      const delay = minDelay + Math.random() * (maxDelay - minDelay); // Tiered thinking delay
      setTimeout(() => {
        if (this.game.state !== 'question' || this.game.currentQuestion !== qi) return;
        if (player.answers.has(qi)) return;
        const correct = Math.random() < player.aiAccuracy;
        let option;
        if (correct) {
          option = q.answer;
        } else {
          const wrong = [0,1,2,3].filter(i => i !== q.answer);
          option = wrong[Math.floor(Math.random() * wrong.length)];
        }
        this._handleAnswer(pid, option);
      }, delay);
    }
  }

  _handleAnswer(playerId, option) {
    const player = this.game.players.get(playerId);
    if (!player || this.game.state !== 'question') return;
    const qi = this.game.currentQuestion;
    if (player.answers.has(qi)) return;

    const elapsed = Date.now() - this.game.questionStartTime;
    const q = this.game.questions[qi];
    if (!q) return;
    let points = 0;
    let speedBonus = 0;
    if (option === q.answer) {
      player.streak = (player.streak || 0) + 1;
      const timeRatio = Math.max(0, 1 - elapsed / this.game.questionDuration);
      speedBonus = Math.round(1000 * timeRatio);
      points = 1000 + speedBonus + Math.max(0, player.streak - 1) * 100;
      player.score += points;
    } else {
      player.streak = 0;
    }
    player.answers.set(qi, { option, time: elapsed, points, speedBonus });

    if (player.ws) player.ws.send(JSON.stringify({ type: 'answer_received', option }));

    if (this.game.adminWs) {
      this.game.adminWs.send(JSON.stringify({
        type: 'answer_progress',
        answered: answeredCount(this.game, qi),
        total: this._connectedPlayerCount(),
      }));
    }

    if (answeredCount(this.game, qi) >= this._connectedPlayerCount()) {
      if (this.timerAbort) this.timerAbort.abort();
      this._revealAnswer();
    }
  }

  _revealAnswer() {
    if (this.game.state !== 'question') return;
    this.game.state = 'reveal';
    const qi = this.game.currentQuestion;
    const q = this.game.questions[qi];
    if (!q) return;
    const stats = getAnswerStats(this.game, qi);
    const teamStats = getTeamStats(this.game, qi, q.answer);
    const leaderboard = getLeaderboard(this.game, 50);
    const isLast = qi >= this.game.questions.length - 1;

    broadcast(this.game, {
      type: 'reveal',
      question: q.question,
      options: q.options,
      correctAnswer: q.answer,
      stats,
      teamStats,
      leaderboard,
      isLast,
      questionIndex: qi,
    });

    for (const [pid, player] of this.game.players.entries()) {
      if (!player.ws) continue;
      try {
        const ans = player.answers.get(qi);
        const correct = ans !== undefined && ans.option === q.answer;
        player.ws.send(JSON.stringify({
          type: 'your_result',
          correct,
          yourAnswer: ans?.option ?? -1,
          correctAnswer: q.answer,
          scoreGained: ans?.points || 0,
          points: ans?.points || 0,
          speedBonus: ans?.speedBonus || 0,
          streak: player.streak || 0,
          totalScore: player.score,
        }));
      } catch {}
    }
  }

  _finishGame() {
    if(this.timerAbort){this.timerAbort.abort();this.timerAbort=null;}
    if(this.game.state === 'finished')return;
    this.game.state = 'finished';
    const leaderboard = getLeaderboard(this.game, 50);
    this.game.finalLeaderboard = leaderboard;
    broadcast(this.game, { type: 'finished', leaderboard });
  }

  _connectedPlayerCount() {
    let count = 0;
    for (const p of this.game.players.values()) {
      if (p.ws || p.isAI) count++;
    }
    return count;
  }

  _resetGame() {
    if (this.timerAbort) { this.timerAbort.abort(); this.timerAbort = null; }
    this.game.state = 'lobby';
    this.game.currentQuestion = -1;
    this.game.finalLeaderboard = null;
    // Close all player WebSockets and clear players
    for (const player of this.game.players.values()) {
      if (player.ws) {
        try { player.ws.send(JSON.stringify({ type: 'reset', state: 'lobby' })); } catch {}
        try { player.ws.close(1000, 'Game reset'); } catch {}
      }
    }
    this.game.players.clear();
    // Notify admin
    if (this.game.adminWs) {
      try {
        this.game.adminWs.send(JSON.stringify({ type: 'reset', state: 'lobby', playerCount: 0, players: [] }));
      } catch {}
    }
  }
}
