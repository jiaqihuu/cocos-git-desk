import { register } from '../registry';
// Domain: common — small helpers shared by the panel and the main process (reflog sources, branch guards, auto-fetch
// settings, prefab diff). Chinese texts are the original strings, byte for byte.
register('zh', {
    'common.reflogHead': 'HEAD · 本工作树',
    'common.reflogCurrentBranch': '当前分支 · {name}',
    'common.reflogLocalBranch': '本地 · {name}',
    'common.reflogRemoteBranch': '远端跟踪（本机） · {name}',
    'common.repoStateUnavailable': '仓库状态不可用，请刷新后重试。',
    'common.fullShaRequired': '请选择已读取的完整提交 SHA。',
    'common.autoFetchFileInvalid': '自动获取设置文件无效。',
    'common.autoFetchCorrupted': '自动获取设置损坏。',
    'common.prefabNotJson': '不是合法的 JSON',
    'common.prefabNotSerialized': '不是 Creator 序列化数组（.prefab／.scene）',
    'common.prefabDeepObject': '[深层对象]',
    'common.prefabDiffSummary': '节点 +{added} −{removed} 移动 {moved} 改名 {renamed}；组件 +{componentsAdded} −{componentsRemoved}；属性改动 {properties}{more}；资源引用变化 {assets}',
});
