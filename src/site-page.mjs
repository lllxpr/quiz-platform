export function sitePage(content, settings) {
  const configuration = JSON.stringify(settings).replace(/</g, '\\u003c');
  const initialization = `<script>window.QUIZ_SITE=${configuration};</script>`;
  const localization = `<script>(function(){
    var site=window.QUIZ_SITE,zh=site.language==='zh-CN';document.documentElement.lang=site.language;
    ['activeQuizTitle','quizWaitTitle'].forEach(function(id){var element=document.getElementById(id);if(element)element.textContent=site.siteName;});
    if(!zh)return;
    if(typeof T!=='undefined')Object.assign(T,{playersJoined:'位玩家已加入',startGame:'开始答题',loading:'加载中…',selectQuiz:'请先选择题库',noQuestions:'这个题库还没有题目，请先添加。',loadFailed:'加载题目失败',answered:'已作答',correctAnswer:'正确答案',next:'下一题',finalRankings:'最终排名',congratulations:'恭喜！',leaderboard:'排行榜',saveResults:'保存成绩',saving:'保存中…',saved:'已保存',saveFailed:'保存失败',restart:'重新开始',resetGame:'重置比赛',placeholder:'输入昵称',join:'加入游戏',waiting:'等待比赛开始…',lookScreen:'请看大屏幕',submitted:'已提交，等待结果…',correct:'答对了！',wrong:'答错了',total:'总分',you:'你',ranked:'你的排名：',thanks:'感谢参与！',yourTotal:'你的总分',noNickname:'请输入昵称',connFailed:'连接失败，请重试'});
    document.querySelectorAll('[data-i18n]').forEach(function(element){if(typeof T!=='undefined'&&T[element.dataset.i18n])element.textContent=T[element.dataset.i18n];});
    var labels={'Start Quiz':'开始答题','History':'历史记录','Manage Quizzes':'管理题库','Log out':'退出登录','Back':'返回','Back to Lobby':'返回大厅','Create':'创建','Login':'登录','Select Quiz':'选择题库'};
    document.querySelectorAll('button,label,.section-label').forEach(function(element){var text=element.textContent.trim();if(labels[text])element.textContent=labels[text];});
    var nickname=document.getElementById('nicknameInput');if(nickname)nickname.placeholder='输入昵称';
  })();</script>`;
  return content.replace('<head>', '<head>'+initialization).replace('</body>', localization+'</body>');
}
