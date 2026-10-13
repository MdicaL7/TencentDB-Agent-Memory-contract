import {describe,expect,it} from 'vitest';
import {opencodeAdapter} from '../agent-adapters/opencode.js';

describe('native OpenCode auxiliary classification',()=>{
  const marker='You are an anchored context summarization assistant for coding sessions.';
  const classify=(messages:unknown[])=>opencodeAdapter.classifyRequest({messages},'/opencode/default/v1/chat/completions',{});
  it('recognizes the native anchored summarizer',()=>{
    expect(classify([{role:'system',content:marker+'\nSummarize only the conversation history you are given.'},{role:'user',content:'Create a new anchored summary.'}])).toBe('auxiliary');
  });
  it('does not classify a resumed business turn by historical summaries',()=>{
    expect(classify([{role:'system',content:'You are a contract assistant.'},{role:'assistant',content:marker},{role:'user',content:'继续核对付款条件'}])).toBe('main');
  });
  it('does not let a user request become an auxiliary request',()=>{
    expect(classify([{role:'user',content:marker}])).toBe('main');
  });
});
