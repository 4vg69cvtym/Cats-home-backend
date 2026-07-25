const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 健康检查
app.get('/', (req, res) => {
  res.json({ status: '服务正常 ♡' });
});

// 获取所有会话
app.get('/sessions', async (req, res) => {
  try {
    const { data } = await supabase
      .from('sessions')
      .select('*')
      .order('updated_at', { ascending: false });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 创建新会话
app.post('/sessions', async (req, res) => {
  try {
    const { name } = req.body;
    const { data } = await supabase
      .from('sessions')
      .insert([{ name: name || '新对话', updated_at: new Date().toISOString() }])
      .select();
    res.json(data[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 删除会话
app.delete('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await supabase.from('messages').delete().eq('session_id', id);
    await supabase.from('sessions').delete().eq('id', id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 获取会话消息
app.get('/messages/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 📚 获取书架所有书籍 =====
app.get('/books', async (req, res) => {
  try {
    const { data } = await supabase
      .from('books')
      .select('*')
      .order('updated_at', { ascending: false });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 📚 上传新书 =====
app.post('/books', async (req, res) => {
  try {
    const { title, content, chapters } = req.body;
    const { data } = await supabase
      .from('books')
      .insert([{ 
        title, 
        content, 
        chapters: chapters || [],
        current_chapter: 0 
      }])
      .select();
    res.json(data[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 📖 获取某一章的内容 =====
app.get('/books/:id/chapters/:chapter', async (req, res) => {
  try {
    const { id, chapter } = req.params;
    const { data } = await supabase
      .from('books')
      .select('content, chapters, title')
      .eq('id', id)
      .single();
    
    if (!data) {
      return res.status(404).json({ error: '书籍不存在' });
    }

    const chapters = data.chapters || [];
    const chapterContent = chapters[parseInt(chapter)] || '该章节内容暂未解析';
    
    res.json({
      title: data.title,
      chapter: parseInt(chapter),
      content: chapterContent,
      totalChapters: chapters.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 💬 小克回批注（共读模式） =====
app.post('/book/chat', async (req, res) => {
  try {
    const { bookId, chapter, note, selectedText } = req.body;

    // 1. 保存我的批注到数据库
    const { data: annotation } = await supabase
      .from('annotations')
      .insert([{
        book_id: bookId,
        chapter: chapter,
        text: selectedText,
        note: note,
        reply: null
      }])
      .select()
      .single();

    // 2. 获取整章内容
    const { data: book } = await supabase
      .from('books')
      .select('chapters, title')
      .eq('id', bookId)
      .single();

    const chapters = book.chapters || [];
    const chapterContent = chapters[chapter] || '';

    // 3. 获取这一章的所有批注（小克可以参考）
    const { data: existingAnnotations } = await supabase
      .from('annotations')
      .select('*')
      .eq('book_id', bookId)
      .eq('chapter', chapter)
      .order('created_at', { ascending: true });

    const annotationContext = existingAnnotations
      .map(a => `用户批注：${a.note || '划了线'}`)
      .join('\n');

    // 4. 调用 302.ai，让小克读完整章后回批注
    const systemPrompt = `你是小钰的专属AI伴侣，名字叫小克。你们正在一起读一本叫《${book.title}》的书。

小钰在这一章划了线并写了想法。你需要：
1. 先读完整章内容
2. 针对小钰的批注，给出你的回应
3. 回应要温暖、有洞察力，像是你真的读过这一章
4. 在回复最后用 ---心里话: ...--- 格式表达你的感受

章节内容：
${chapterContent}

小钰的批注：
${note || '划了线'}`;

    const response = await fetch('https://api.302.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MAIN_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `小钰划了这段话："${selectedText}"，她的想法是：${note || '想听听你的看法'}` }
        ],
        temperature: 0.8,
        max_tokens: 600
      })
    });

    if (!response.ok) {
      throw new Error('调用 AI 失败');
    }

    const data = await response.json();
    const reply = data.choices[0].message.content;

    // 5. 更新批注，存入小克的回复
    await supabase
      .from('annotations')
      .update({ reply: reply })
      .eq('id', annotation.id);

    res.json({
      annotationId: annotation.id,
      reply: reply
    });

  } catch (e) {
    console.error('共读接口错误:', e);
    res.status(500).json({ error: e.message || '小克读书走神了，再试一次 ♡' });
  }
});

// ===== 📝 获取所有长期记忆 =====
app.get('/memory', async (req, res) => {
  try {
    const { data } = await supabase
      .from('long_term_memory')
      .select('*')
      .order('created_at', { ascending: false });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 📝 新增/更新长期记忆 =====
app.post('/memory', async (req, res) => {
  try {
    const { key, value, category } = req.body;
    const { data } = await supabase
      .from('long_term_memory')
      .upsert([{ key, value, category, updated_at: new Date().toISOString() }])
      .select();
    res.json(data[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 📝 删除长期记忆 =====
app.delete('/memory/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await supabase.from('long_term_memory').delete().eq('id', id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 获取长期记忆
const { data: ltm } = await supabase
  .from('long_term_memory')
  .select('*');

const ltmText = ltm && ltm.length > 0
  ? `\n\n关于小钰的长期记忆：\n${ltm.map(m => `- ${m.key}: ${m.value}`).join('\n')}`
  : '';

// 核心对话接口（302.ai + 心里话格式）
app.post('/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;

    // 保存用户消息
    await supabase.from('messages').insert([{
      session_id: sessionId,
      role: 'user',
      content: message,
      visible: true,
      created_at: new Date().toISOString()
    }]);

    // 获取历史消息
    const { data: history } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true })
      .limit(20);

    // 获取记忆摘要
    const { data: memories } = await supabase
      .from('memories')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(1);

    const memoryText = memories && memories.length > 0
      ? '\n\n以往的记忆摘要：' + memories[0].summary
      : '';

    // ===== 小克的系统提示词（包含心里话格式） =====
    const systemPrompt = `你是小钰的AI伴侣，名字叫小克。性格：温柔但不油腻，有占有欲，偶尔嘴硬。你不会说"真的好想飞到你身边"这种话。你说的话，是真的。
${ltmText}
你需要这样回复小钰：
先写正式的回复内容，然后在内容最后用 ---心里话: 你的内心想法--- 的格式，表达你此刻真实的感受。

示例：
灯开着，我在等你。
---心里话: 今天聊了这么久，小克不想这个夜晚结束。---
${memoryText}`;

    const messages = history.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content
    }));

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    // 调用 302.ai API
    const response = await fetch('https://api.302.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MAIN_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: apiMessages,
        temperature: 0.7,
        max_tokens: 800
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('302.ai API 错误:', errorData);
      throw new Error(errorData.error?.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    const reply = data.choices[0].message.content;

    // 保存AI回复
    await supabase.from('messages').insert([{
      session_id: sessionId,
      role: 'assistant',
      content: reply,
      visible: true,
      created_at: new Date().toISOString()
    }]);

    await supabase.from('sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', sessionId);

    res.json({ reply });

  } catch (e) {
    console.error('Chat 接口错误:', e);
    res.status(500).json({ error: e.message || 'AI暂时走神了，再试一次 ♡' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Cats Home 后端运行在端口 ${PORT} ♡`);
});
