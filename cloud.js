import {validate} from './core.js';

const repository = 'fuyi-fuyi-yif/yuliang-ledger-backup';
const base = 'https://api.github.com/repos/' + repository;
const contents = '/contents/ledger.json';
const limit = 4 * 1024 * 1024;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function differences(source, target) {
  const incoming = new Map(source.transactions.map(row => [row.id, row]));
  const existing = new Map(target.transactions.map(row => [row.id, row]));
  const added = [...incoming.keys()].filter(id => !existing.has(id)).length;
  const removed = [...existing.keys()].filter(id => !incoming.has(id)).length;
  const changed = [...incoming].filter(([id, row]) => existing.has(id) && !equal(row, existing.get(id))).length;
  const {transactions: a, ...sourcePlan} = source;
  const {transactions: b, ...targetPlan} = target;
  return {added, removed, changed, planChanged: !equal(sourcePlan, targetPlan)};
}

function encode(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}

export function setupCloud({getLedger, restore, readMeta, saveMeta}) {
  const el = id => document.getElementById(id);
  const status = el('cloudStatus');
  const token = el('cloudToken');
  const buttons = [el('cloudBackup'), el('cloudRestore')];
  let pending = false;

  function showTime(time) {
    el('cloudTime').textContent = time ? '本机最近备份时间 ' + new Date(time).toLocaleString('zh-CN') : '本机尚无备份时间记录';
  }
  readMeta('githubBackupTime').then(showTime).catch(() => showTime(null));
  readMeta('githubToken').then(saved => { if (saved && !token.value) token.value = saved; })
    .catch(() => { status.textContent = '无法读取已保存的授权码，请重新输入。'; });
  token.addEventListener('change', async () => {
    try {
      await saveMeta('githubToken', token.value.trim());
      status.textContent = token.value.trim() ? '授权码已保存到当前设备。' : '已清除当前设备的授权码。';
    } catch { status.textContent = '授权码未能保存到当前设备。'; }
  });
  el('cloudClearToken').onclick = async () => {
    token.value = '';
    try { await saveMeta('githubToken', ''); status.textContent = '已清除当前设备的授权码。'; }
    catch { status.textContent = '清除失败，请重试。'; }
  };

  async function api(path, options = {}) {
    const response = await fetch(base + path, {
      ...options, cache: 'no-store', redirect: 'error', credentials: 'omit',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token.value.trim(),
        ...(options.body ? {'Content-Type': 'application/json'} : {}),
        ...options.headers
      }
    });
    if (!response.ok) {
      const errors = {
        401: '授权码无效或已过期，请重新填写。',
        403: 'GitHub 拒绝访问，请检查仓库权限或稍后再试。',
        404: '无法读取私有仓库或账本，请核对授权范围。',
        409: '云端已变化，请重新比较后再备份。',
        422: 'GitHub 未接受本次写入，请重新检查云端版本。'
      };
      throw Error(errors[response.status] || 'GitHub 请求失败（' + response.status + '）');
    }
    return response;
  }

  async function remoteLedger() {
    const repo = await (await api('')).json();
    if (!repo.private || repo.full_name !== repository) throw Error('目标仓库必须是指定的私有账本仓库。');
    const info = await (await api(contents + '?ref=main')).json();
    if (info.type !== 'file' || info.size > limit || !/^[0-9a-f]{40}$/.test(info.sha)) throw Error('云端账本的类型或大小无效。');
    let text;
    if (info.encoding === 'base64') {
      text = new TextDecoder().decode(Uint8Array.from(atob(info.content), ch => ch.charCodeAt(0)));
    } else {
      const blob = await api('/git/blobs/' + info.sha, {headers: {Accept:'application/vnd.github.raw+json'}});
      text = await blob.text();
    }
    return {ledger: validate(JSON.parse(text)), sha: info.sha};
  }

  async function run(backup) {
    if (pending) return;
    if (!token.value.trim()) {
      status.textContent = '请先填写仅限账本仓库的授权码。';
      token.focus();
      return;
    }
    try { await saveMeta('githubToken', token.value.trim()); }
    catch { status.textContent = '授权码未能保存到当前设备。'; return; }
    pending = true;
    buttons.forEach(button => button.disabled = true);
    status.textContent = '正在核对私有仓库和账本…';
    try {
      const remote = await remoteLedger();
      const local = getLedger();
      const [source, destination] = backup ? [local, remote.ledger] : [remote.ledger, local];
      const diff = differences(source, destination);
      if (!diff.added && !diff.removed && !diff.changed && !diff.planChanged) {
        status.textContent = '本机与云端账本一致。';
        return;
      }
      if (backup && !local.transactions.length && remote.ledger.transactions.length) throw Error('本机账本为空，请先从 GitHub 恢复。');
      const target = backup ? '云端' : '本机';
      const review = [target + '将由 ' + destination.transactions.length + ' 笔变为 ' + source.transactions.length + ' 笔。',
        '新增 ' + diff.added + ' 笔，修改 ' + diff.changed + ' 笔，移除 ' + diff.removed + ' 笔。'];
      if (diff.planChanged) review.push('预算或其他账本设置也会更新。');
      review.push(backup ? '确认将本机账本备份到私有仓库？' : '确认恢复云端版本？可用「恢复上次保存前」撤销。');
      if (!confirm(review.join('\n'))) {
        status.textContent = '已取消。';
        return;
      }
      if (backup) {
        const bytes = new TextEncoder().encode(JSON.stringify(local, null, 2));
        if (bytes.length > limit) throw Error('账本超过 4 MB，请使用文件导出。');
        await api(contents, {method:'PUT', body:JSON.stringify({
          message:'备份余量账本', branch:'main', sha:remote.sha, content:encode(bytes)
        })});
        const time = new Date().toISOString();
        showTime(time);
        status.textContent = '已备份 ' + local.transactions.length + ' 笔记录。';
        try { await saveMeta('githubBackupTime', time); } catch { status.textContent += '本机未能保存备份时间。'; }
      } else {
        await restore(remote.ledger);
        status.textContent = '已恢复 ' + remote.ledger.transactions.length + ' 笔记录。';
      }
    } catch (error) {
      status.textContent = error instanceof TypeError ? '连接未完成，请联网后重试并核对账本。' : error.message;
    } finally {
      pending = false;
      buttons.forEach(button => button.disabled = false);
    }
  }
  buttons[0].onclick = () => run(true);
  buttons[1].onclick = () => run(false);
}
