import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** GitHub-flavored Markdown 表示 (assistant 応答・提案説明など)。 */
export function Md({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
