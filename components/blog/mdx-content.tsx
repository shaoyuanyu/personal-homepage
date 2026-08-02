import { run } from "@mdx-js/mdx";
import * as runtime from "react/jsx-runtime";
import Link from "next/link";

/**
 * 渲染 Velite `s.mdx()` 编译出的函数体代码。
 * 在服务端（RSC）执行，支持自定义组件映射。
 */
export async function MDXContent({ code }: { code: string }) {
  const { default: Content } = await run(code, {
    ...runtime,
    baseUrl: import.meta.url,
    useMDXComponents: () => ({
      a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <Link href={props.href ?? "#"} {...props} />
      ),
    }),
  });

  return <Content />;
}
