const defaults={title:'Скоро',intro:'Что-то хорошее начинается. И ты — часть этой истории.',accent:'#b7b2f5'};
const enc=new TextEncoder();
export async function hmac(key,value){const k=await crypto.subtle.importKey('raw',typeof key==='string'?enc.encode(key):key,{name:'HMAC',hash:'SHA-256'},false,['sign']);return new Uint8Array(await crypto.subtle.sign('HMAC',k,enc.encode(value)));}
export async function authenticate(raw,token){if(!raw||!token)throw Error('Открой приложение через Telegram.');const p=new URLSearchParams(raw);const hash=p.get('hash');p.delete('hash');const date=Number(p.get('auth_date'));if(!Number.isFinite(date)||Date.now()/1000-date>86400||date>Date.now()/1000+60)throw Error('Сессия истекла. Открой приложение заново.');const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n');const digest=await hmac(await hmac('WebAppData',token),check);const actual=[...digest].map(x=>x.toString(16).padStart(2,'0')).join('');if(!hash||hash.length!==64||[...actual].reduce((v,c,i)=>v|(c.charCodeAt(0)^hash.charCodeAt(i)),0))throw Error('Недействительная сессия.');const user=JSON.parse(p.get('user')||'null');if(!user?.id)throw Error('Нет пользователя.');return user;}
const json=(x,status=200)=>Response.json(x,{status,headers:{'Cache-Control':'no-store'}});
async function telegram(env,method,data){const r=await fetch('https://api.telegram.org/bot'+env.BOT_TOKEN+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const v=await r.json();return v;}
const admin=(u,e)=>(e.ADMIN_IDS||'').split(',').map(x=>x.trim()).includes(String(u.id));
async function config(db){return await db.prepare('SELECT title,intro,accent FROM settings WHERE id=1').first()||defaults;}
async function enablePollAnswers(env){const info=await telegram(env,'getWebhookInfo',{});if(!info.ok)throw Error('Не удалось проверить приём ответов Telegram.');const url='https://skequqvzqzogfuemuzqn.supabase.co/functions/v1/domashka/telegram';if(info.result.url!==url)throw Error('Проверь подключение Telegram: адрес webhook отличается.');if(!info.result.allowed_updates?.includes('poll_answer')||!info.result.allowed_updates?.includes('callback_query')){const result=await telegram(env,'setWebhook',{url,secret_token:env.WEBHOOK_SECRET,allowed_updates:[...new Set([...(info.result.allowed_updates||['message']),'message','poll_answer','callback_query'])]});if(!result.ok)throw Error('Не удалось включить приём ответов Telegram.');}}
const attendanceOptions = ['Буду!', 'Не буду', 'Дам ответ позже'];
function isAttendanceOptions(options) {
  return Array.isArray(options) && (options.length===2 || options.length===3) && options.every((text,index)=>text===attendanceOptions[index]);
}
function attendanceKeyboard(pollId, selected, options=attendanceOptions) {
  const buttons = options.map((text, index) => ({
    text: selected === index ? '✓ ' + text : text,
    callback_data: 'attendance:' + pollId + ':' + index,
  }));
  return {inline_keyboard: [buttons.slice(0, 2), buttons.slice(2)].filter(row=>row.length)};
}

async function handleAttendance(env, update) {
  const callback = update.callback_query;
  const match = /^attendance:([a-f0-9-]{36}):([0-2])$/.exec(callback.data || '');
  if (!match || callback.message?.chat.type !== 'private') return;
  const [, pollId, option] = match;
  const memberId = String(callback.from.id);
  const answer = Number(option);
  const delivery = await env.DB.prepare(`SELECT d.message_id, p.active, p.audience, p.options, m.is_core
    FROM poll_deliveries d JOIN domashka.polls p ON p.id=d.poll_id
    JOIN domashka.members m ON m.id=d.member_id
    WHERE d.poll_id=? AND d.member_id=? AND d.status='sent' AND d.telegram_poll_id IS NULL`)
    .bind(pollId, memberId).first();
  const reply = (text) => telegram(env,'answerCallbackQuery',{callback_query_id:callback.id,text});
  if (!delivery || !delivery.active || (delivery.audience==='core' && delivery.is_core!==1)) {
    await reply('Опрос закрыт или недоступен.');
    return;
  }
  const options = JSON.parse(delivery.options);
  if (!isAttendanceOptions(options) || answer>=options.length) { await reply('Такого варианта ответа нет.'); return; }
  const remindAt = answer===2 ? new Date(Date.now()+172800000).toISOString() : null;
  const saved = await env.DB.prepare(`INSERT INTO answers(poll_id,member_id,answer,last_update_id,remind_at)
    SELECT p.id,?, ?, ?, ?::timestamptz FROM polls p WHERE p.id=? AND p.active=1
    ON CONFLICT(poll_id,member_id) DO UPDATE SET answer=excluded.answer,
      last_update_id=excluded.last_update_id,
      remind_at=CASE WHEN answers.answer=2 AND excluded.answer=2 THEN answers.remind_at ELSE excluded.remind_at END
    WHERE answers.last_update_id<excluded.last_update_id`)
    .bind(memberId,answer,update.update_id,remindAt,pollId).run();
  await reply(saved.meta.changes ? (answer===2?'Напомню через два дня.':'Ответ сохранён.') : 'Ответ уже обработан.');
  if (saved.meta.changes) await telegram(env,'editMessageReplyMarkup',{
    chat_id:memberId,message_id:callback.message.message_id,reply_markup:attendanceKeyboard(pollId,answer,options)
  });
}

async function sendAttendanceReminders(env) {
  const due = await env.DB.prepare(`SELECT a.poll_id,a.member_id,p.question,p.active,p.audience,m.is_core,m.subscribed
    FROM answers a JOIN domashka.polls p ON p.id=a.poll_id JOIN domashka.members m ON m.id=a.member_id
    WHERE a.remind_at<=now() AND a.answer=2 ORDER BY a.remind_at LIMIT 20`).all();
  for (const item of due.results) {
    const claim = await env.DB.prepare('UPDATE answers SET remind_at=NULL WHERE poll_id=? AND member_id=? AND answer=2 AND remind_at<=now()')
      .bind(item.poll_id,item.member_id).run();
    if (!claim.meta.changes || !item.active || !item.subscribed || (item.audience==='core'&&item.is_core!==1)) continue;
    try {
      const result = await telegram(env,'sendMessage',{chat_id:item.member_id,text:'Напоминание: '+item.question,
        protect_content:true,reply_markup:attendanceKeyboard(item.poll_id,2)});
      if (result.error_code===429) await env.DB.prepare(
        "UPDATE answers SET remind_at=now()+interval '5 minutes' WHERE poll_id=? AND member_id=? AND answer=2 AND remind_at IS NULL"
      ).bind(item.poll_id,item.member_id).run();
    } catch (error) { console.error('Poll reminder delivery uncertain',error.name); }
  }
}
async function queuePoll(env,p){await env.DB.prepare("INSERT OR IGNORE INTO poll_deliveries(poll_id,member_id) SELECT ?,id FROM members WHERE subscribed=1 AND (?='all' OR is_core=1)").bind(p.id,p.audience).run();}
export default {async fetch(req,env,ctx){const path=new URL(req.url).pathname;
try{
if(path==='/icon.jpg'&&req.method==='GET')return new Response(Uint8Array.from(atob(iconBase64),c=>c.charCodeAt(0)),{headers:{'Content-Type':'image/jpeg','Cache-Control':'public,max-age=86400'}});
if(path==='/'&&req.method==='GET')return new Response(page,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
if(path==='/api/config')return json(env.DB?await config(env.DB):defaults);
if(path==='/telegram'&&req.method==='POST'){
if(!env.WEBHOOK_SECRET||req.headers.get('X-Telegram-Bot-Api-Secret-Token')!==env.WEBHOOK_SECRET)return json({error:'Forbidden'},403);
const update=await req.json();
if(update.domashka_reminders===true){await sendAttendanceReminders(env);return json({ok:true});}
if(update.callback_query){await handleAttendance(env,update);return json({ok:true});}
if(update.poll_answer){const a=update.poll_answer;if(!a.user?.id||!Number.isSafeInteger(update.update_id))return json({ok:true});const delivery=await env.DB.prepare('SELECT * FROM poll_deliveries WHERE telegram_poll_id=?').bind(a.poll_id).first();if(!delivery){const inflight=await env.DB.prepare("SELECT poll_id FROM poll_deliveries WHERE status='sending' LIMIT 1").first();return inflight?json({error:'Poll mapping not ready'},503):json({ok:true});}if(String(a.user.id)!==delivery.member_id)return json({ok:true});const poll=await env.DB.prepare('SELECT * FROM polls WHERE id=?').bind(delivery.poll_id).first();const voter=await env.DB.prepare('SELECT id,is_core FROM members WHERE id=?').bind(delivery.member_id).first();if(!poll||!poll.active||poll.deleted_at||!voter||(poll.audience==='core'&&voter.is_core!==1))return json({ok:true});if(!Array.isArray(a.option_ids)||a.option_ids.length>1||a.option_ids.some(x=>!Number.isInteger(x)||x<0||x>=JSON.parse(poll.options).length))return json({ok:true});await env.DB.prepare('INSERT INTO answers(poll_id,member_id,answer,last_update_id) VALUES(?,?,?,?) ON CONFLICT(poll_id,member_id) DO UPDATE SET answer=excluded.answer,last_update_id=excluded.last_update_id WHERE answers.last_update_id<excluded.last_update_id').bind(poll.id,delivery.member_id,a.option_ids[0]??-1,update.update_id).run();return json({ok:true});}
const m=update.message;if(m?.chat.type==='private'){
if(m.text==='/start'||m.text?.startsWith('/start '))await telegram(env,'sendMessage',{chat_id:m.chat.id,text:'Привет! Тебя здесь ждали.\nСкоро начнётся новая история нашей домашки. Ответь на несколько вопросов — так мы сможем выбрать удобное время встречи.',reply_markup:{inline_keyboard:[[{text:'Приоткрыть дверь',web_app:{url:env.APP_URL}}]]}});
if(admin(m.from,env)&&(m.voice||m.video_note)){const type=m.voice?'voice':'video_note';const file=(m.voice||m.video_note).file_id;const source=String(m.chat.id)+':'+String(m.message_id);await env.DB.prepare('INSERT OR IGNORE INTO broadcasts(id,body,created_at,audience,media_type,media_file_id,source_message_id,media_thumbnail_file_id) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),type==='voice'?'Голосовое сообщение':'Видеокружок',new Date().toISOString(),'all',type,file,source,m.video_note?.thumbnail?.file_id||null).run();await telegram(env,'sendMessage',{chat_id:m.chat.id,text:'Запись сохранена как черновик. Открой админку → «Рассылка», выбери «Всем» или «Только активу» и отправь после проверки. Получателям пока ничего не отправлено.',reply_markup:{inline_keyboard:[[{text:'Открыть админку',web_app:{url:env.APP_URL}}]]}});}
if(m.text==='/id')await telegram(env,'sendMessage',{chat_id:m.chat.id,text:'Твой Telegram ID: '+m.from.id});
if(m.text==='/stop') {await env.DB.prepare('UPDATE members SET subscribed=0 WHERE id=?').bind(String(m.from.id)).run();await telegram(env,'sendMessage',{chat_id:m.chat.id,text:'Рассылки отключены. Включить их можно в своей анкете.'});}
}return json({ok:true});}
if(!path.startsWith('/api/'))return json({error:'Not found'},404);
if(!env.BOT_TOKEN||!env.DB)return json({error:'Приложение готовится к запуску. Подключение Telegram ещё не завершено.'},503);
const u=await authenticate(req.headers.get('X-Telegram-Init-Data'),env.BOT_TOKEN),id=String(u.id),isAdmin=admin(u,env);
if(path==='/api/me'&&req.method==='GET'){const storedMember=await env.DB.prepare('SELECT * FROM members WHERE id=?').bind(id).first();const member=storedMember?Object.fromEntries(Object.entries(storedMember).filter(([key])=>key!=='is_core')):null;const polls=await env.DB.prepare("SELECT id,question,options FROM polls WHERE active=1 AND deleted_at IS NULL AND channel='web' AND (audience='all' OR ?=1)").bind(storedMember?.is_core===1?1:0).all();const answers=await env.DB.prepare('SELECT poll_id,answer FROM answers WHERE member_id=? AND answer>=0').bind(id).all();return json({member,isAdmin,polls:polls.results,answers:answers.results});}
const b=req.method==='POST'?await req.json():{};
if(path==='/api/saturday-availability'&&req.method==='POST'){
  const pollId='8f953ea1-68a4-4270-8a72-9dfb001845cd';
  const options=['Да','Нет','Пока не знаю'];
  if(!Number.isInteger(b.answer)||!options[b.answer])throw Error('Выбери ответ.');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO polls(id,question,options,active,audience,channel) VALUES(?,?,?,1,?,?) ON CONFLICT(id) DO NOTHING').bind(pollId,'Сможешь ли ты ходить на домашку по субботам в 19:00 возле церкви?',JSON.stringify(options),'all','web'),
    env.DB.prepare("INSERT INTO members(id,username,first_name,last_name,days,times,subscribed,updated_at) SELECT ?,?,?,?,?,?,0,? FROM polls WHERE id=? AND active=1 AND deleted_at IS NULL ON CONFLICT(id) DO NOTHING").bind(id,u.username||'',u.first_name||'Участник',u.last_name||'','[]','[]',new Date().toISOString(),pollId),
    env.DB.prepare('INSERT INTO answers(poll_id,member_id,answer) SELECT id,?,? FROM polls WHERE id=? AND active=1 AND deleted_at IS NULL ON CONFLICT(poll_id,member_id) DO UPDATE SET answer=excluded.answer').bind(id,b.answer,pollId)
  ]);
  const poll=await env.DB.prepare('SELECT active,deleted_at FROM polls WHERE id=?').bind(pollId).first();
  if(!poll?.active||poll.deleted_at)throw Error('Опрос закрыт.');
  return json({ok:true});
}
if(path==='/api/register'&&req.method==='POST'){
for(const k of ['first_name','last_name'])if(typeof b[k]!=='string'||!b[k].trim()||b[k].length>80)throw Error('Укажи имя и фамилию (до 80 символов).');
if(!Array.isArray(b.days)||!b.days.length||b.days.some(x=>!Number.isInteger(x)||x<1||x>6||x===3)||!Array.isArray(b.times)||!b.times.length||b.times.some(x=>![18,19].includes(x)))throw Error('Выбери удобные дни и время.');
if(b.consent!==true)throw Error('Подтверди передачу анкеты организатору.');
await env.DB.prepare('INSERT INTO members(id,username,first_name,last_name,days,times,subscribed,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,days=excluded.days,times=excluded.times,subscribed=excluded.subscribed,updated_at=excluded.updated_at').bind(id,u.username||'',b.first_name.trim(),b.last_name.trim(),JSON.stringify([...new Set(b.days)]),JSON.stringify([...new Set(b.times)]),b.subscribed?1:0,new Date().toISOString()).run();return json({ok:true});}
if(path==='/api/delete-registration'&&req.method==='POST'){await env.DB.batch([env.DB.prepare('DELETE FROM poll_deliveries WHERE member_id=?').bind(id),env.DB.prepare('DELETE FROM answers WHERE member_id=?').bind(id),env.DB.prepare('DELETE FROM deliveries WHERE member_id=?').bind(id),env.DB.prepare('DELETE FROM members WHERE id=?').bind(id)]);return json({ok:true});}
if(path==='/api/answer'&&req.method==='POST'){const poll=await env.DB.prepare("SELECT * FROM polls WHERE id=? AND active=1 AND deleted_at IS NULL AND channel='web'").bind(b.poll_id).first();const member=await env.DB.prepare('SELECT id,is_core FROM members WHERE id=?').bind(id).first();if(!member||!poll||(poll.audience==='core'&&member.is_core!==1)||!Number.isInteger(b.answer)||b.answer<0||b.answer>=JSON.parse(poll.options).length)throw Error('Проверь ответ.');await env.DB.prepare('INSERT INTO answers(poll_id,member_id,answer) VALUES(?,?,?) ON CONFLICT(poll_id,member_id) DO UPDATE SET answer=excluded.answer').bind(poll.id,id,b.answer).run();return json({ok:true});}
if(!isAdmin)return json({error:'Доступ только организатору.'},403);
if(path==='/api/admin'&&req.method==='GET'){const [members,polls,answers,broadcasts]=await Promise.all(['members','polls','answers','broadcasts'].map(t=>env.DB.prepare('SELECT * FROM '+t).all()));return json({members:members.results,polls:polls.results,answers:answers.results.filter(a=>a.answer>=0),broadcasts:broadcasts.results,config:await config(env.DB)});}
if(path==='/api/member-core'&&req.method==='POST'){if(typeof b.id!=='string'||typeof b.is_core!=='boolean')throw Error('Проверь участника.');const target=await env.DB.prepare('SELECT id FROM members WHERE id=?').bind(b.id).first();if(!target)return json({error:'Участник не найден.'},404);await env.DB.prepare('UPDATE members SET is_core=? WHERE id=?').bind(b.is_core?1:0,b.id).run();return json({ok:true});}
if(path==='/api/settings'&&req.method==='POST'){if(typeof b.title!=='string'||b.title.length>80||!b.title.trim()||typeof b.intro!=='string'||b.intro.length>500||!/^#[0-9a-f]{6}$/i.test(b.accent))throw Error('Проверь название, текст и цвет.');await env.DB.prepare('INSERT INTO settings VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,intro=excluded.intro,accent=excluded.accent').bind(b.title,b.intro,b.accent).run();return json({ok:true});}
if(path==='/api/polls'&&req.method==='POST'){if(typeof b.question!=='string'||!b.question.trim()||b.question.length>300||!Array.isArray(b.options)||b.options.length<2||b.options.length>12||b.options.some(x=>typeof x!=='string'||!x.trim()||x.length>100))throw Error('Нужен вопрос и от 2 до 12 вариантов.');const audience=b.audience||'all',channel=b.channel||'web';if(!['all','core'].includes(audience)||!['web','telegram'].includes(channel))throw Error('Выбери получателей.');if(channel==='telegram')await enablePollAnswers(env);const pollId=b.id||crypto.randomUUID();if(!/^[-a-z0-9]{36}$/.test(pollId))throw Error('Проверь идентификатор опроса.');await env.DB.prepare('INSERT OR IGNORE INTO polls(id,question,options,active,audience,channel) VALUES(?,?,?,1,?,?)').bind(pollId,b.question.trim(),JSON.stringify(b.options.map(x=>x.trim())),audience,channel).run();const poll=await env.DB.prepare('SELECT * FROM polls WHERE id=?').bind(pollId).first();if(poll.deleted_at||!poll.active)throw Error('Опрос уже закрыт.');if(poll.channel==='telegram')await queuePoll(env,poll);return json({ok:true,id:pollId});}
if(path==='/api/poll-queue'&&req.method==='POST'){const p=await env.DB.prepare('SELECT * FROM polls WHERE id=?').bind(b.id).first();if(!p||p.deleted_at||!p.active)throw Error('Опрос закрыт или удалён.');await enablePollAnswers(env);await env.DB.prepare("UPDATE polls SET channel='telegram' WHERE id=?").bind(p.id).run();await queuePoll(env,p);return json({ok:true});}
if(path==='/api/poll-send'&&req.method==='POST'){const p=await env.DB.prepare('SELECT * FROM polls WHERE id=?').bind(b.id).first();if(!p||p.deleted_at||!p.active||p.channel!=='telegram')throw Error('Опрос закрыт или удалён.');const rows=await env.DB.prepare("SELECT * FROM poll_deliveries WHERE poll_id=? AND status='pending' LIMIT 10").bind(p.id).all();for(const r of rows.results){const claim=await env.DB.prepare("UPDATE poll_deliveries SET status='sending' WHERE poll_id=? AND member_id=? AND status='pending'").bind(p.id,r.member_id).run();if(!claim.meta.changes)continue;const recipient=await env.DB.prepare('SELECT subscribed,is_core FROM members WHERE id=?').bind(r.member_id).first();const current=await env.DB.prepare('SELECT active,deleted_at FROM polls WHERE id=?').bind(p.id).first();if(!recipient?.subscribed||!current?.active||current.deleted_at||(p.audience==='core'&&recipient.is_core!==1)){await env.DB.prepare("UPDATE poll_deliveries SET status='skipped' WHERE poll_id=? AND member_id=?").bind(p.id,r.member_id).run();continue;}try{const buttons=isAttendanceOptions(JSON.parse(p.options));const res=buttons?await telegram(env,'sendMessage',{chat_id:r.member_id,text:p.question,protect_content:true,reply_markup:attendanceKeyboard(p.id,undefined,JSON.parse(p.options))}):await telegram(env,'sendPoll',{chat_id:r.member_id,question:p.question,options:JSON.parse(p.options).map(text=>({text})),is_anonymous:false,type:'regular',allows_multiple_answers:false,allows_revoting:true,protect_content:true});if(res.ok&&res.result?.message_id&&(buttons||res.result.poll?.id)){await env.DB.prepare("UPDATE poll_deliveries SET status='sent',telegram_poll_id=?,message_id=? WHERE poll_id=? AND member_id=?").bind(res.result.poll?.id??null,res.result.message_id,p.id,r.member_id).run();}else{await env.DB.prepare('UPDATE poll_deliveries SET status=? WHERE poll_id=? AND member_id=?').bind(res.error_code===429?'pending':'failed',p.id,r.member_id).run();if(res.error_code===429)break;}}catch{await env.DB.prepare("UPDATE poll_deliveries SET status='uncertain' WHERE poll_id=? AND member_id=?").bind(p.id,r.member_id).run();}}const counts=await env.DB.prepare('SELECT status,COUNT(*) count FROM poll_deliveries WHERE poll_id=? GROUP BY status').bind(p.id).all();return json({counts:counts.results});}
if(path==='/api/poll-close'&&req.method==='POST'){await env.DB.batch([env.DB.prepare('UPDATE polls SET active=0 WHERE id=?').bind(b.id),env.DB.prepare("UPDATE poll_deliveries SET status='skipped' WHERE poll_id=? AND status='pending'").bind(b.id)]);return json({ok:true});}
if(path==='/api/poll-delete'&&req.method==='POST'){await env.DB.batch([env.DB.prepare('UPDATE polls SET active=0,deleted_at=? WHERE id=?').bind(new Date().toISOString(),b.id),env.DB.prepare("UPDATE poll_deliveries SET status='skipped' WHERE poll_id=? AND status='pending'").bind(b.id)]);return json({ok:true});}
if(path==='/api/poll-restore'&&req.method==='POST'){await env.DB.prepare('UPDATE polls SET deleted_at=NULL,active=0 WHERE id=?').bind(b.id).run();return json({ok:true});}
if(path==='/api/poll-sync'&&req.method==='POST'){const p=await env.DB.prepare('SELECT * FROM polls WHERE id=?').bind(b.id).first();if(!p||p.active)throw Error('Сначала закрой опрос.');const column=p.deleted_at?'removed':'closed';const rows=await env.DB.prepare("SELECT * FROM poll_deliveries WHERE poll_id=? AND status='sent' AND "+column+'=0 LIMIT 10').bind(p.id).all();let failed=0;for(const r of rows.results){try{const res=await telegram(env,p.deleted_at?'deleteMessage':r.telegram_poll_id?'stopPoll':'editMessageReplyMarkup',{chat_id:r.member_id,message_id:r.message_id,...(!p.deleted_at&&!r.telegram_poll_id?{reply_markup:{inline_keyboard:[]}}:{})});if(!res.ok){failed++;if(p.deleted_at)await telegram(env,'stopPoll',{chat_id:r.member_id,message_id:r.message_id});}}catch{failed++;}await env.DB.prepare('UPDATE poll_deliveries SET '+column+'=1 WHERE poll_id=? AND member_id=?').bind(p.id,r.member_id).run();}const next=await env.DB.prepare("SELECT member_id FROM poll_deliveries WHERE poll_id=? AND status='sent' AND "+column+'=0 LIMIT 1').bind(p.id).first();return json({ok:true,pending:!!next,failed});}
if(path==='/api/broadcast'&&req.method==='POST'){if(typeof b.body!=='string'||!b.body.trim()||b.body.length>4000||!b.id||!/^[-a-z0-9]{36}$/.test(b.id))throw Error('Сообщение должно содержать от 1 до 4000 символов.');if(b.audience===undefined)b.audience='all';if(!['all','core'].includes(b.audience))throw Error('Выбери получателей.');await env.DB.batch([env.DB.prepare('INSERT OR IGNORE INTO broadcasts(id,body,created_at,audience) VALUES(?,?,?,?)').bind(b.id,b.body,new Date().toISOString(),b.audience),env.DB.prepare("INSERT OR IGNORE INTO deliveries(broadcast_id,member_id) SELECT ?,id FROM members WHERE subscribed=1 AND ((SELECT audience FROM broadcasts WHERE id=?)='all' OR is_core=1)").bind(b.id,b.id)]);return json({ok:true,id:b.id});}
if(path==='/api/media-content'&&req.method==='POST'){
 try {
  const draft=await env.DB.prepare('SELECT * FROM broadcasts WHERE id=?').bind(b.id).first();
  if(!draft||!['voice','video_note'].includes(draft.media_type))return json({error:'Запись не найдена.'},404);
  if(!['thumbnail','media'].includes(b.kind))return json({error:'Проверь тип предпросмотра.'},400);
  const fileId=b.kind==='thumbnail'?draft.media_thumbnail_file_id:draft.media_file_id;
  if(!fileId)return json({error:'Для этой записи нет миниатюры.'},404);
  const file=await telegram(env,'getFile',{file_id:fileId});
  if(!file.ok||!file.result?.file_path)return json({error:'Не удалось загрузить запись. Её можно посмотреть в Telegram.'},502);
  // Only a Telegram-issued path for this saved record may be fetched. Never return the bot URL.
  const path=file.result.file_path;
  if(typeof path!=='string'||!/^[-a-zA-Z0-9_./]+$/.test(path)||path.split('/').includes('..'))return json({error:'Некорректный файл.'},502);
  const remote=await fetch('https://api.telegram.org/file/bot'+env.BOT_TOKEN+'/'+path,{redirect:'error'});
  if(!remote.ok)return json({error:'Запись временно недоступна. Попробуй ещё раз.'},502);
  return new Response(remote.body,{headers:{
    'Content-Type':b.kind==='thumbnail'?'image/jpeg':draft.media_type==='voice'?'audio/ogg':'video/mp4',
    'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
    'Content-Disposition':'inline'
  }});
 } catch { return json({error:'Не удалось загрузить предпросмотр. Попробуй ещё раз или открой запись в Telegram.'},502); }
}
if(path==='/api/media-preview'&&req.method==='POST'){const draft=await env.DB.prepare('SELECT * FROM broadcasts WHERE id=?').bind(b.id).first();if(!draft||!['voice','video_note'].includes(draft.media_type))throw Error('Запись не найдена.');const result=await telegram(env,draft.media_type==='voice'?'sendVoice':'sendVideoNote',{chat_id:id,[draft.media_type]:draft.media_file_id});if(!result.ok)throw Error('Не удалось показать запись.');return json({ok:true});}
if(path==='/api/media-queue'&&req.method==='POST'){if(b.audience===undefined)b.audience='all';if(!['all','core'].includes(b.audience))throw Error('Выбери получателей.');const draft=await env.DB.prepare('SELECT * FROM broadcasts WHERE id=?').bind(b.id).first();if(!draft||!['voice','video_note'].includes(draft.media_type))throw Error('Запись не найдена.');const existing=await env.DB.prepare('SELECT member_id FROM deliveries WHERE broadcast_id=? LIMIT 1').bind(b.id).first();if(existing)throw Error('Эта запись уже поставлена в очередь. Продолжи существующую рассылку.');const queueToken=crypto.randomUUID();await env.DB.batch([env.DB.prepare('UPDATE broadcasts SET audience=?,queue_token=? WHERE id=? AND queue_token IS NULL AND NOT EXISTS (SELECT 1 FROM deliveries WHERE broadcast_id=?)').bind(b.audience,queueToken,b.id,b.id),env.DB.prepare("INSERT OR IGNORE INTO deliveries(broadcast_id,member_id) SELECT ?,id FROM members WHERE subscribed=1 AND (?='all' OR is_core=1) AND EXISTS (SELECT 1 FROM broadcasts WHERE id=? AND queue_token=?)").bind(b.id,b.audience,b.id,queueToken)]);return json({ok:true});}
if(path==='/api/broadcast-send'&&req.method==='POST'){const broadcast=await env.DB.prepare('SELECT * FROM broadcasts WHERE id=?').bind(b.id).first();if(!broadcast)throw Error('Рассылка не найдена.');const rows=await env.DB.prepare("SELECT member_id FROM deliveries WHERE broadcast_id=? AND status='pending' LIMIT 10").bind(b.id).all();for(const r of rows.results){const claim=await env.DB.prepare("UPDATE deliveries SET status='sending' WHERE broadcast_id=? AND member_id=? AND status='pending'").bind(b.id,r.member_id).run();if(!claim.meta.changes)continue;const recipient=await env.DB.prepare('SELECT subscribed,is_core FROM members WHERE id=?').bind(r.member_id).first();if(!recipient||!recipient.subscribed||(broadcast.audience==='core'&&recipient.is_core!==1)){await env.DB.prepare("UPDATE deliveries SET status='skipped' WHERE broadcast_id=? AND member_id=?").bind(b.id,r.member_id).run();continue;}try{const media=['voice','video_note'].includes(broadcast.media_type);const method=media?(broadcast.media_type==='voice'?'sendVoice':'sendVideoNote'):'sendMessage';const res=await telegram(env,method,media?{chat_id:r.member_id,[broadcast.media_type]:broadcast.media_file_id}:{chat_id:r.member_id,text:broadcast.body});await env.DB.prepare('UPDATE deliveries SET status=? WHERE broadcast_id=? AND member_id=?').bind(res.ok?'sent':res.error_code===429?'pending':'failed',b.id,r.member_id).run();if(res.error_code===429)break;}catch{await env.DB.prepare("UPDATE deliveries SET status='uncertain' WHERE broadcast_id=? AND member_id=?").bind(b.id,r.member_id).run();}}
const counts=await env.DB.prepare('SELECT status,COUNT(*) count FROM deliveries WHERE broadcast_id=? GROUP BY status').bind(b.id).all();return json({counts:counts.results});}
return json({error:'Not found'},404);
}catch(e){return json({error:e.message||'Не удалось выполнить действие.'},400);}}};

const page="";const iconBase64="";
