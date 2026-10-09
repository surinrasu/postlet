const languages = ["en", "zh-Hans", "zh-Hant"];
// Each entry is English, Simplified Chinese, Traditional Chinese.
const copy = {
  title: ["Account access", "账户访问", "帳戶存取"],
  intro: [
    "Manage access with a passkey. Passkeys, app passwords and recovery codes expire after 90 days.",
    "使用通行密钥管理访问权限。通行密钥、应用密码和恢复码均为 90 天有效。",
    "使用通行密鑰管理存取權限。通行密鑰、應用程式密碼和復原碼均為 90 天有效。",
  ],
  login: ["Sign in with a passkey", "使用通行密钥登录", "使用通行密鑰登入"],
  recovery: ["Use a recovery code", "使用恢复码", "使用復原碼"],
  recoveryHelp: [
    "A recovery code lets you add a replacement passkey. Sign in with the new passkey to access your account.",
    "恢复码可用于添加新的通行密钥。添加后，请使用新密钥登录账户。",
    "復原碼可用於新增通行密鑰。新增後，請使用新密鑰登入帳戶。",
  ],
  recoveryCode: ["Recovery code", "恢复码", "復原碼"],
  recover: ["Recover access", "恢复访问", "復原存取權限"],
  setup: [
    "For initial setup, run the setup command in the project directory.",
    "首次设置请在项目目录运行设置命令。",
    "首次設定請在專案目錄執行設定指令。",
  ],
  addKey: ["Add a passkey", "添加通行密钥", "新增通行密鑰"],
  keyName: ["Passkey name", "通行密钥名称", "通行密鑰名稱"],
  defaultKey: ["My passkey", "我的通行密钥", "我的通行密鑰"],
  createKey: ["Create passkey", "创建通行密钥", "建立通行密鑰"],
  keys: ["Passkeys", "通行密钥", "通行密鑰"],
  cascade: [
    "When revoking a passkey, also revoke all credentials and client permissions it issued.",
    "撤销通行密钥时，同时撤销由其签发的所有凭据和客户端授权。",
    "撤銷通行密鑰時，同時撤銷由其簽發的所有憑證和用戶端授權。",
  ],
  clients: ["Authorized clients", "已授权客户端", "已授權用戶端"],
  revokeAll: [
    "Revoke all client permissions",
    "撤销全部客户端授权",
    "撤銷全部用戶端授權",
  ],
  recoveryTitle: ["Account recovery", "账户恢复", "帳戶復原"],
  recoveryInfo: [
    "Keep recovery codes offline or add a spare passkey. Generating new codes invalidates the previous set.",
    "请离线保存恢复码，或添加备用通行密钥。生成新恢复码后，旧码立即失效。",
    "請離線保存復原碼，或新增備用通行密鑰。產生新復原碼後，舊碼立即失效。",
  ],
  newRecovery: ["Generate recovery codes", "生成恢复码", "產生復原碼"],
  apps: ["App passwords", "应用密码", "應用程式密碼"],
  appHelp: [
    "For JMAP clients that require a password. Each password has its own permissions and can be revoked separately.",
    "供需要密码的 JMAP 客户端使用。每个应用密码都有独立权限，可单独撤销。",
    "供需要密碼的 JMAP 用戶端使用。每個應用程式密碼都有獨立權限，可單獨撤銷。",
  ],
  appName: ["Client name", "客户端名称", "用戶端名稱"],
  write: [
    "Create, change and delete email",
    "创建、修改和删除邮件",
    "建立、修改和刪除郵件",
  ],
  send: ["Send email", "发送邮件", "傳送郵件"],
  read: ["Read email and attachments", "读取邮件和附件", "讀取郵件和附件"],
  offline_access: [
    "Offline access with automatic renewal",
    "离线访问与自动续期",
    "離線存取與自動續期",
  ],
  createApp: ["Create app password", "创建应用密码", "建立應用程式密碼"],
  logout: ["Sign out", "退出登录", "登出"],
  save: ["Save this credential", "保存凭据", "保存憑證"],
  saveHelp: [
    "This value is shown once. Save it in a password manager or a secure offline location.",
    "以下内容仅显示一次。请保存在密码管理器或安全的离线位置。",
    "以下內容僅顯示一次。請保存在密碼管理器或安全的離線位置。",
  ],
  saved: ["Saved", "已保存", "已保存"],
  revoke: ["Revoke", "撤销", "撤銷"],
  renew: ["Renew for 90 days", "续期 90 天", "續期 90 天"],
  empty: ["None", "暂无", "暫無"],
  expires: ["Expires", "到期", "到期"],
  activeCodes: ["Valid recovery codes", "有效恢复码", "有效復原碼"],
  noCodes: [
    "No valid recovery codes. Generate and save a new set.",
    "没有有效恢复码。请生成并保存新码。",
    "沒有有效復原碼。請產生並保存新碼。",
  ],
  failed: [
    "The operation could not be completed. Please try again.",
    "操作未完成，请重试。",
    "操作未完成，請重試。",
  ],
  canceled: [
    "Verification was canceled or could not be completed. Please try again.",
    "验证已取消或未能完成，请重试。",
    "驗證已取消或未能完成，請重試。",
  ],
  unsupported: [
    "This browser does not support passkeys. Use a supported browser or another device.",
    "此浏览器不支持通行密钥。请使用受支持的浏览器或其他设备。",
    "此瀏覽器不支援通行密鑰。請使用受支援的瀏覽器或其他裝置。",
  ],
  keyAdded: ["Passkey added.", "通行密钥已添加。", "通行密鑰已新增。"],
  loginNew: [
    "Passkey added. Sign in with it to continue.",
    "通行密钥已添加。请使用新密钥登录。",
    "通行密鑰已新增。請使用新密鑰登入。",
  ],
  rotated: [
    "The previous app password is no longer valid. Update your client with the new password.",
    "旧应用密码已失效。请在客户端中更新为新密码。",
    "舊應用程式密碼已失效。請在用戶端中更新為新密碼。",
  ],
  confirmRecovery: [
    "Generate new recovery codes? The previous set will stop working immediately.",
    "生成新的恢复码？旧码将立即失效。",
    "產生新的復原碼？舊碼將立即失效。",
  ],
  confirmAll: [
    "Revoke all OAuth client permissions?",
    "撤销全部 OAuth 客户端授权？",
    "撤銷全部 OAuth 用戶端授權？",
  ],
  authorize: ["Authorize client", "授权客户端", "授權用戶端"],
  request: [
    "requests access to your mailbox.",
    "请求访问你的邮箱。",
    "要求存取你的信箱。",
  ],
  domain: ["Client domain", "客户端域名", "用戶端網域"],
  unverified: [
    "The client provided this name. Its identity has not been verified.",
    "此名称由客户端提供，其身份未经验证。",
    "此名稱由用戶端提供，其身分未經驗證。",
  ],
  returnTo: ["Return address", "授权返回地址", "授權返回位址"],
  localClient: [
    "This is a local application. Continue only if you just started connecting it.",
    "这是本机应用。仅在你刚刚发起连接时继续。",
    "這是本機應用程式。僅在你剛剛發起連線時繼續。",
  ],
  permissions: ["Permissions", "权限", "權限"],
  scopeHelp: [
    "Sending also requires permission to change email. Offline access lasts 14 days before a new authorization is required.",
    "发信还需要修改邮件权限。离线访问有效期为 14 天，到期后需要重新授权。",
    "傳送郵件亦需要修改郵件權限。離線存取有效期為 14 天，到期後需要重新授權。",
  ],
  allow: ["Allow", "允许", "允許"],
  deny: ["Deny", "拒绝", "拒絕"],
  consentHelp: [
    "Confirm with a valid passkey. You can revoke permission at any time from Account access.",
    "请使用有效的通行密钥确认。你可随时在账户访问页面撤销授权。",
    "請使用有效的通行密鑰確認。你可隨時在帳戶存取頁面撤銷授權。",
  ],
  language: ["Language", "语言", "語言"],
  applyLanguage: ["Apply language", "切换语言", "切換語言"],
};

// Protocol errors remain structured JSON; only the human-readable message varies.
export const authErrors = {
  invalidLabel: [
    "Enter a name between 1 and 80 characters.",
    "请输入 1–80 字的名称。",
    "請輸入 1–80 字的名稱。",
  ],
  invalidPermissions: ["Invalid permissions.", "无效的权限。", "無效的權限。"],
  missingPermissions: [
    "Read permission is required. Sending also requires write permission.",
    "需要读取权限；发信还需要修改权限。",
    "需要讀取權限；傳送郵件亦需要修改權限。",
  ],
  rateLimited: [
    "Too many requests. Please try again later.",
    "请求过于频繁，请稍后重试。",
    "請求過於頻繁，請稍後重試。",
  ],
  signInRequired: [
    "Sign in with a passkey first.",
    "请先使用 Passkey 登录。",
    "請先使用通行密鑰登入。",
  ],
  pageExpired: [
    "This page has expired. Reload it and try again.",
    "页面已失效，请刷新后重试。",
    "頁面已失效，請重新載入後再試。",
  ],
  wrongAuthDomain: [
    "Use the account's configured authentication domain.",
    "请使用账户的固定认证域名。",
    "請使用帳戶的固定驗證網域。",
  ],
  clientLimit: [
    "The client registration limit has been reached.",
    "客户端注册数量已达上限。",
    "用戶端註冊數量已達上限。",
  ],
  crossOrigin: [
    "Requests from other websites are not allowed.",
    "不允许来自其他网站的请求。",
    "不允許來自其他網站的請求。",
  ],
  endpointNotFound: ["Endpoint not found.", "未找到此接口。", "找不到此介面。"],
  jsonRequired: [
    "The request must use JSON.",
    "请求需要 JSON。",
    "請求需要 JSON。",
  ],
  invalidJson: ["Invalid JSON.", "无效的 JSON。", "無效的 JSON。"],
  invalidRequest: ["Invalid request.", "无效的请求。", "無效的請求。"],
  invalidSetupLink: ["Invalid setup link.", "设置链接无效。", "設定連結無效。"],
  setupLinkExpired: [
    "The setup link is invalid or has expired.",
    "设置链接无效或已过期。",
    "設定連結無效或已過期。",
  ],
  invalidRecoveryCode: [
    "Invalid recovery code.",
    "恢复码无效。",
    "復原碼無效。",
  ],
  recoveryCodeExpired: [
    "The recovery code is invalid, expired or already used.",
    "恢复码无效或已使用。",
    "復原碼無效、已過期或已使用。",
  ],
  invalidVerificationOperation: [
    "Invalid verification operation.",
    "无效的验证操作。",
    "無效的驗證操作。",
  ],
  verificationSessionMismatch: [
    "Verification does not belong to this session.",
    "验证不属于当前会话。",
    "驗證不屬於目前工作階段。",
  ],
  loginBrowserMismatch: [
    "The sign-in request does not belong to this browser.",
    "登录请求不属于当前浏览器。",
    "登入請求不屬於目前瀏覽器。",
  ],
  passkeyExpired: [
    "This passkey is invalid or expired. Use another valid credential.",
    "Passkey 无效或已过期，请使用其他有效凭据。",
    "通行密鑰無效或已過期，請使用其他有效憑證。",
  ],
  passkeyVerificationRetry: [
    "Passkey verification failed. Please try again.",
    "Passkey 验证失败，请重试。",
    "通行密鑰驗證失敗，請重試。",
  ],
  passkeyVerificationFailed: [
    "Passkey verification failed.",
    "Passkey 验证失败。",
    "通行密鑰驗證失敗。",
  ],
  passkeyLimit: [
    "Up to 10 passkeys can be stored.",
    "最多可保存 10 把 Passkey。",
    "最多可保存 10 把通行密鑰。",
  ],
  setupCompleted: [
    "Initial setup has already been completed.",
    "首次设置已完成。",
    "首次設定已完成。",
  ],
  registrationSessionMismatch: [
    "The registration request does not belong to this session.",
    "注册请求不属于当前会话。",
    "註冊請求不屬於目前工作階段。",
  ],
  issuerExpired: [
    "The authorizing credential is no longer valid. Please try again.",
    "签发凭据已经失效，请重试。",
    "簽發憑證已經失效，請重試。",
  ],
  passkeyRegistrationFailed: [
    "Passkey registration failed. Please try again.",
    "Passkey 注册验证失败，请重试。",
    "通行密鑰註冊驗證失敗，請重試。",
  ],
  passkeyNotVerified: [
    "This passkey could not be verified.",
    "无法验证此 Passkey。",
    "無法驗證此通行密鑰。",
  ],
  passkeyAlreadyRegistered: [
    "This passkey is already registered.",
    "此 Passkey 已注册。",
    "此通行密鑰已註冊。",
  ],
  lastPasskey: [
    "Keep at least one valid passkey, or add a spare passkey first.",
    "请保留至少一把有效 Passkey，或先添加备用 Passkey。",
    "請保留至少一把有效通行密鑰，或先新增備用通行密鑰。",
  ],
  passkeyNotFound: [
    "Passkey not found.",
    "未找到此 Passkey。",
    "找不到此通行密鑰。",
  ],
  appPasswordNotFound: [
    "App password not found.",
    "未找到此应用凭据。",
    "找不到此應用程式密碼。",
  ],
  appPasswordLimit: [
    "Up to 32 app passwords can be stored.",
    "应用凭据最多 32 个。",
    "最多可保存 32 個應用程式密碼。",
  ],
  invalidGrantId: [
    "Invalid permission identifier.",
    "无效的授权编号。",
    "無效的授權編號。",
  ],
  invalidVerificationRequest: [
    "Invalid verification request.",
    "无效的验证请求。",
    "無效的驗證請求。",
  ],
  challengeExpired: [
    "The verification request has expired or was already used.",
    "验证请求已过期或已使用。",
    "驗證請求已過期或已使用。",
  ],
  reauthenticationRequired: [
    "Verify your passkey again to complete this operation.",
    "此操作需要重新验证 Passkey。",
    "此操作需要重新驗證通行密鑰。",
  ],
  proofMismatch: [
    "Verification expired or does not match this operation. Please try again.",
    "验证已失效或不属于此操作，请重试。",
    "驗證已失效或不屬於此操作，請重試。",
  ],
  invalidCredentialId: [
    "Invalid credential identifier.",
    "无效的凭据编号。",
    "無效的憑證編號。",
  ],
  pkceRequired: [
    "The client must use PKCE S256.",
    "客户端必须使用 PKCE S256。",
    "用戶端必須使用 PKCE S256。",
  ],
  methodNotAllowed: [
    "Request method not supported.",
    "不支持此请求方式。",
    "不支援此請求方式。",
  ],
  invalidAuthorizationRequest: [
    "Invalid authorization request.",
    "无效的授权请求。",
    "無效的授權請求。",
  ],
  authorizationPageExpired: [
    "This authorization page has expired. Connect again from your client.",
    "授权页面已失效，请从客户端重新连接。",
    "授權頁面已失效，請從用戶端重新連線。",
  ],
  authorizationRequestExpired: [
    "The authorization request is invalid or expired. Connect again from your client.",
    "授权请求无效或已过期，请从客户端重新连接。",
    "授權請求無效或已過期，請從用戶端重新連線。",
  ],
  authenticationUnavailable: [
    "Authentication is temporarily unavailable. Please try again later.",
    "认证服务暂时不可用，请稍后重试。",
    "驗證服務暫時無法使用，請稍後重試。",
  ],
};
export function language(request) {
  const selected = new URL(request.url).searchParams.get("lang");
  if (languages.includes(selected)) return selected;
  const cookie = /(?:^|;\s*)postlet-language=([^;]+)/.exec(
    request.headers.get("Cookie") || "",
  )?.[1];
  if (languages.includes(cookie)) return cookie;
  const accepted = (request.headers.get("Accept-Language") || "en")
    .split(",")
    .map((part) => {
      const [tag, weight] = part.trim().split(";q=");
      return { tag: tag.toLowerCase(), weight: weight ? Number(weight) : 1 };
    })
    .sort((a, b) => b.weight - a.weight);
  for (const { tag, weight } of accepted) {
    if (!(weight > 0)) continue;
    if (/^zh-(tw|hk|mo|hant)(-|$)/.test(tag)) return "zh-Hant";
    if (tag === "zh" || tag.startsWith("zh-")) return "zh-Hans";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return "en";
}
export function messages(locale) {
  const index = languages.indexOf(locale);
  return Object.fromEntries(
    Object.entries(copy).map(([key, values]) => [
      key,
      values[index < 0 ? 0 : index],
    ]),
  );
}
export function errorMessage(code, request) {
  const locale = language(request);
  return (
    authErrors[code]?.[languages.indexOf(locale)] || messages(locale).failed
  );
}
