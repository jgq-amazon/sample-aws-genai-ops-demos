import Box from "@cloudscape-design/components/box";
import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Avatar from "@cloudscape-design/chat-components/avatar";
import ChatBubble from "@cloudscape-design/chat-components/chat-bubble";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import PolicyViewer from "./PolicyViewer";
import FindingsTable from "./FindingsTable";
import DependencyGraph from "./DependencyGraph";
import { Message, Finding, DependencyResult } from "../types";

interface MessageBubbleProps {
  message: Message;
  /**
   * Called when the user clicks "Try again" on an error message. Only
   * meaningful when `message.kind === "error"` and the parent supplied
   * a `retryPrompt` — otherwise omit.
   */
  onRetry?: () => void;
}

/**
 * Custom renderers passed to `<ReactMarkdown>` so that markdown emitted by
 * the model is themed via Cloudscape primitives instead of raw HTML with
 * inline styles. Only the elements that differ from the browser default
 * are overridden — headings, paragraphs, lists, emphasis, and line breaks
 * inherit the Cloudscape global stylesheet and are left alone.
 *
 * SAFETY: this component tree is the ONLY path model output takes to the
 * DOM (see #167 Req 1). We render through `<ReactMarkdown>` with the
 * `rehypeSanitize` plugin using its default GitHub-derived schema, which
 * strips `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, every
 * `on*=` event handler, and any `javascript:` URL BEFORE this components
 * table is ever consulted. `dangerouslySetInnerHTML` is never used
 * anywhere in this file, so a malicious model turn (or a user turn the
 * model reflects back) cannot inject executable HTML.
 */
const MARKDOWN_COMPONENTS: Components = {
  // Links: external http(s) URLs open in a new tab with rel=noopener
  // noreferrer (both to prevent reverse-tabnabbing and to keep referer
  // headers off the third party). Non-http links (e.g. `#anchor`,
  // `mailto:`) render as inline Cloudscape links that stay in the SPA.
  a: ({ href, children }) => {
    const isExternal =
      typeof href === "string" && /^https?:\/\//i.test(href);
    return (
      <Link
        href={href}
        external={isExternal}
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
        variant="primary"
      >
        {children}
      </Link>
    );
  },

  // Inline `code` spans get a monospace + subtle background treatment.
  // Fenced code blocks (```...```) do NOT reach this renderer — they are
  // intercepted upstream by `parseAssistantMessage` and rendered through
  // `<PolicyViewer>` (which handles syntax highlighting and copy). If a
  // fenced block ever DOES slip through, the default <pre><code> render
  // is safe; it just won't be prettified.
  code: ({ children, className }) => {
    const isBlock = typeof className === "string" && className.startsWith("language-");
    if (isBlock) {
      // Rare: a fenced block that parseAssistantMessage missed. Render
      // as a plain preformatted block rather than as inline text.
      return (
        <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
          <code className={className}>{children}</code>
        </pre>
      );
    }
    return (
      <Box variant="code" display="inline">
        {children}
      </Box>
    );
  },
};

export default function MessageBubble({ message, onRetry }: MessageBubbleProps) {
  // Error rendering per #167 Req 7: a failed turn is a single inline
  // Cloudscape <Alert type="error"> at the position of the failure, with
  // a Try again action wired to re-send the original user prompt through
  // the parent's handleSend. This replaces the previous double-render
  // (top-of-container Alert + assistant text bubble parroting the error).
  if (message.kind === "error") {
    return (
      <Alert
        type="error"
        header="The request could not complete"
        action={
          onRetry ? (
            <Button onClick={onRetry} variant="normal">
              Try again
            </Button>
          ) : undefined
        }
      >
        {message.content}
      </Alert>
    );
  }

  const isUser = message.role === "user";

  // Cloudscape chat pattern: EVERY message renders in a <ChatBubble> with
  // an <Avatar> as the authorship cue. The embedded pattern the AWS
  // console uses for assistants inside an <AppLayout> content area is
  // one-sided (all bubbles left-aligned); alternating left/right without
  // avatars is a hybrid the pattern explicitly warns against (#167 Req 2).
  const avatar = isUser ? (
    // Initials-based user avatars require the Cognito email or display
    // name to be fetched at mount time. That plumbing is a small follow-up;
    // for this PR the fallback icon avatar named by #167 Req 2.3 is used.
    <Avatar iconName="user-profile" tooltipText="You" ariaLabel="Your message" />
  ) : (
    <Avatar
      iconName="gen-ai"
      color="gen-ai"
      tooltipText="Generative AI assistant"
      ariaLabel="Generative AI assistant response"
    />
  );

  return (
    <ChatBubble
      type={isUser ? "outgoing" : "incoming"}
      avatar={avatar}
      ariaLabel={isUser ? "Your message" : "Generative AI assistant response"}
    >
      {isUser ? (
        // User content is plain text; render as a paragraph with preserved
        // whitespace (so line breaks the user typed survive).
        <Box variant="p">
          <span style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
            {message.content}
          </span>
        </Box>
      ) : (
        // Assistant content is parsed into sections: text (markdown),
        // policy documents (JSON), findings tables, dependency graphs.
        // The section renderers are unchanged from the prior surface.
        <AssistantSections message={message} />
      )}
    </ChatBubble>
  );
}

function AssistantSections({ message }: { message: Message }) {
  const sections = parseAssistantMessage(message.content);

  return (
    <SpaceBetween size="s">
      {sections.map((section, index) => {
        switch (section.type) {
          case "policy":
            return (
              <PolicyViewer
                key={index}
                policy={section.content}
                title={section.title}
                reductionMetrics={section.metrics}
              />
            );
          case "findings":
            return (
              <FindingsTable
                key={index}
                findings={section.findings}
                summary={section.summary}
              />
            );
          case "dependencies":
            return <DependencyGraph key={index} data={section.data} />;
          case "text":
          default:
            return (
              <div
                key={index}
                style={{
                  color: "var(--color-text-body-default)",
                  lineHeight: 1.6,
                }}
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeSanitize]}
                  components={MARKDOWN_COMPONENTS}
                >
                  {section.content}
                </ReactMarkdown>
                {section.content.length > 200 && (
                  <div
                    style={{
                      marginTop: "8px",
                      borderTop:
                        "1px solid var(--color-border-divider-default)",
                      paddingTop: "8px",
                    }}
                  >
                    <DownloadButton content={message.content} />
                  </div>
                )}
              </div>
            );
        }
      })}
    </SpaceBetween>
  );
}

// --- Message Parsing ---

interface TextSection {
  type: "text";
  content: string;
}

interface PolicySection {
  type: "policy";
  content: string;
  title?: string;
  metrics?: {
    current_actions: number;
    proposed_actions: number;
    removed_actions: number;
    reduction_percentage: number;
  };
}

interface FindingsSection {
  type: "findings";
  findings: Finding[];
  summary?: { severity_breakdown?: Record<string, number> };
}

interface DependenciesSection {
  type: "dependencies";
  data: DependencyResult;
}

type MessageSection = TextSection | PolicySection | FindingsSection | DependenciesSection;

function parseAssistantMessage(content: string): MessageSection[] {
  const sections: MessageSection[] = [];

  // Try to detect JSON code blocks with policy content
  const codeBlockRegex = /```(?:json|python|typescript)?\s*\n([\s\S]*?)\n```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Text before the code block
    if (match.index > lastIndex) {
      const textBefore = content.slice(lastIndex, match.index).trim();
      if (textBefore) {
        sections.push({ type: "text", content: textBefore });
      }
    }

    const codeContent = match[1].trim();

    if (/^https?:\/\/\S+$/.test(codeContent)) {
      // A lone URL fenced as a code block (e.g. a presigned download link the
      // model wrapped in ```) should be a clickable link, not a monospace box.
      sections.push({ type: "text", content: codeContent });
    } else if (isPolicyDocument(codeContent)) {
      sections.push({
        type: "policy",
        content: codeContent,
        title: "IAM Policy",
      });
    } else {
      // Generic code block — still render as policy viewer (syntax highlighted)
      sections.push({
        type: "policy",
        content: codeContent,
        title: "Code",
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last code block
  if (lastIndex < content.length) {
    const remaining = content.slice(lastIndex).trim();
    if (remaining) {
      sections.push({ type: "text", content: remaining });
    }
  }

  // If no code blocks found, return as single text section
  if (sections.length === 0) {
    sections.push({ type: "text", content });
  }

  return sections;
}

function isPolicyDocument(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return (
      parsed.Version === "2012-10-17" ||
      parsed.Statement !== undefined ||
      (parsed.Type && parsed.Properties?.PolicyDocument)
    );
  } catch {
    // Check for CDK patterns
    return (
      content.includes("iam.PolicyDocument(") ||
      content.includes("new iam.PolicyDocument(") ||
      content.includes("iam.PolicyStatement(")
    );
  }
}

function DownloadButton({ content }: { content: string }) {
  const handleDownload = async () => {
    const filename = `iam-analysis-${new Date().toISOString().slice(0, 10)}.md`;
    const blob = new Blob([content], { type: "text/markdown" });

    // Try modern File System Access API first (proper Save As dialog)
    if ((window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker) {
      try {
        const handle = await (window as unknown as { showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (err: unknown) {
        if ((err as Error).name === "AbortError") return;
      }
    }

    // Fallback: blob URL with download attribute
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Button iconName="download" variant="normal" onClick={handleDownload}>
      Save as .md
    </Button>
  );
}
