import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

export async function POST(request: Request) {
  try {
    const { prompt } = await request.json();

    if (!prompt) {
      return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
    }

    const {
      ANTHROPIC_API_KEY,
      GITHUB_TOKEN,
      GITHUB_USERNAME,
      GITHUB_TEMPLATE_REPO,
      VERCEL_TOKEN
    } = process.env;

    if (!ANTHROPIC_API_KEY || !GITHUB_TOKEN || !GITHUB_USERNAME || !GITHUB_TEMPLATE_REPO || !VERCEL_TOKEN) {
      return NextResponse.json({ 
        error: "Thiếu các biến môi trường cấu hình (API Keys, GitHub, Vercel)" 
      }, { status: 500 });
    }

    // --- 1. Gọi AI Sinh Code ---
    console.log("1. Generating code with Claude...");
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const aiResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-6", // Sử dụng model Claude Sonnet 4.6 mới nhất
      max_tokens: 4000,
      system: "Bạn là một chuyên gia lập trình Frontend (Next.js & Tailwind). Nhiệm vụ của bạn là tạo ra một Landing Page (file page.tsx) tuyệt đẹp. Chỉ trả về duy nhất đoạn code hoàn chỉnh của file page.tsx (React Component), không bọc trong markdown, không giải thích.",
      messages: [
        {
          role: "user",
          content: `Hãy viết toàn bộ mã nguồn cho trang chủ (page.tsx) dựa trên yêu cầu sau: ${prompt}. Giao diện cần hiện đại, có Hero section, Features. Sử dụng TailwindCSS.`,
        }
      ]
    });

    let generatedCode = "";
    if (aiResponse.content[0].type === "text") {
      generatedCode = aiResponse.content[0].text;
    }
    generatedCode = generatedCode.replace(/```tsx\n/gi, '').replace(/```typescript\n/gi, '').replace(/```\n/gi, '').replace(/```/gi, '').trim();

    // --- 2. Tạo Repository Mới Từ Template (GitHub API) ---
    console.log("2. Creating GitHub Repository...");
    const repoName = `auto-site-${Date.now()}`;
    
    const cleanPromptForDescription = prompt.replace(/[\n\r\t]/g, ' ').substring(0, 50);

    const createRepoRes = await fetch(`https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_TEMPLATE_REPO}/generate`, {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        owner: GITHUB_USERNAME,
        name: repoName,
        description: `Tự động tạo website dựa trên prompt: ${cleanPromptForDescription}...`,
        include_all_branches: false,
        private: false
      })
    });

    if (!createRepoRes.ok) {
      const err = await createRepoRes.json();
      throw new Error(`Lỗi tạo GitHub Repo: ${err.message}`);
    }

    const repoData = await createRepoRes.json();
    const repoFullName = repoData.full_name;
    const githubUrl = repoData.html_url;
    const defaultBranch = repoData.default_branch || "main";

    console.log("Waiting for GitHub repo to initialize...");
    await delay(4000);

    // --- 3. Cập nhật file page.tsx ---
    console.log("3. Updating page.tsx in the new repo...");
    const filePath = "src/app/page.tsx";

    let fileSha = "";
    let retryCount = 0;
    while (retryCount < 3) {
      const getFileRes = await fetch(`https://api.github.com/repos/${repoFullName}/contents/${filePath}`, {
        headers: {
          "Authorization": `Bearer ${GITHUB_TOKEN}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        }
      });

      if (getFileRes.ok) {
        const fileData = await getFileRes.json();
        fileSha = fileData.sha;
        break;
      }
      retryCount++;
      await delay(2000);
    }

    const updateRes = await fetch(`https://api.github.com/repos/${repoFullName}/contents/${filePath}`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: "Auto-generate page.tsx via AI",
        content: Buffer.from(generatedCode).toString('base64'),
        sha: fileSha || undefined
      })
    });

    if (!updateRes.ok) {
      const err = await updateRes.json();
      throw new Error(`Lỗi cập nhật code lên GitHub: ${err.message}`);
    }

    // --- 4. Tạo Project & Deploy trên Vercel ---
    console.log("4. Creating Vercel Project and Deploying...");
    
    // Để deploy qua API Vercel với Github, chúng ta cần repo ID. Cần gọi Github API lần nữa để lấy
    const ghRepoInfo = await fetch(`https://api.github.com/repos/${repoFullName}`, {
      headers: { "Authorization": `Bearer ${GITHUB_TOKEN}`, "Accept": "application/vnd.github.v3+json" }
    }).then(res => res.json());
    const githubRepoId = ghRepoInfo.id;

    // Create Vercel Project
    const createVercelProjectRes = await fetch("https://api.vercel.com/v9/projects", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${VERCEL_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: repoName,
        framework: "nextjs",
        gitRepository: {
          type: "github",
          repo: repoFullName,
          repoId: githubRepoId
        }
      })
    });

    if (!createVercelProjectRes.ok) {
      const err = await createVercelProjectRes.json();
      throw new Error(`Lỗi tạo Vercel Project: ${err.error?.message || JSON.stringify(err)}`);
    }

    // Trigger Vercel Deployment
    const triggerDeployRes = await fetch("https://api.vercel.com/v13/deployments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${VERCEL_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: repoName,
        gitSource: {
          type: "github",
          repo: repoFullName,
          repoId: githubRepoId,
          ref: defaultBranch
        }
      })
    });

    if (!triggerDeployRes.ok) {
      const err = await triggerDeployRes.json();
      throw new Error(`Lỗi trigger Vercel Deploy: ${err.error?.message || JSON.stringify(err)}`);
    }

    const deployData = await triggerDeployRes.json();
    const vercelUrl = `https://${deployData.url}`; // e.g. https://auto-site-12345.vercel.app

    // --- 5. Trả kết quả về cho Frontend ---
    console.log("5. Done! Returning results.");
    return NextResponse.json({ 
      success: true, 
      githubUrl,
      repoFullName,
      vercelUrl
    });

  } catch (error: any) {
    console.error("Error generating website:", error);
    return NextResponse.json({ error: error.message || "Lỗi nội bộ server" }, { status: 500 });
  }
}
