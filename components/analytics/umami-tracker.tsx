"use client";

import { useEffect } from "react";

/**
 * Umami 自托管统计埋点（https://status.shaoyuanyu.cn）。
 *
 * 仅在线上域名注入脚本，本地开发 / 其他环境不产生数据。
 * website id 为公开信息（访客可在页面源码中看到），直接写入代码。
 * 若更换统计服务或域名，修改下方常量即可。
 */
const UMAMI_SRC = "https://status.shaoyuanyu.cn/script.js";
const UMAMI_WEBSITE_ID = "5c270808-4fc5-46b3-a6e5-8e577c083a05";
const PROD_HOSTS = ["shaoyuanyu.cn", "www.shaoyuanyu.cn"];

export function UmamiTracker() {
  useEffect(() => {
    const { hostname } = window.location;
    if (!PROD_HOSTS.includes(hostname)) return;
    // 防止重复注入（HMR / 重复挂载）
    if (document.querySelector(`script[data-website-id="${UMAMI_WEBSITE_ID}"]`)) return;

    const script = document.createElement("script");
    script.async = true;
    script.defer = true;
    script.src = UMAMI_SRC;
    script.dataset.websiteId = UMAMI_WEBSITE_ID;
    document.head.appendChild(script);
  }, []);

  return null;
}
