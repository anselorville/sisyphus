"""
Python LLM Client 示例
展示如何使用 python-dotenv 和 openai 包连接 OpenAI-compatible API
"""

import os
from dotenv import load_dotenv
from openai import OpenAI

# 加载 .env 文件
load_dotenv()

# 从环境变量获取配置
API_KEY = os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY")
BASE_URL = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1")
MODEL = os.getenv("LLM_MODEL", "gpt-3.5-turbo")

def create_client():
    """创建 OpenAI 客户端（支持 OpenAI-compatible API）"""
    if not API_KEY:
        raise ValueError(
            "API key not found. Please set LLM_API_KEY or OPENAI_API_KEY in .env file"
        )

    return OpenAI(
        api_key=API_KEY,
        base_url=BASE_URL
    )

def chat_completion(messages: list[dict], stream: bool = False):
    """
    发送聊天请求

    Args:
        messages: 消息列表，格式：[{"role": "user", "content": "..."}]
        stream: 是否流式返回

    Returns:
        响应文本或流式生成器
    """
    client = create_client()

    response = client.chat.completions.create(
        model=MODEL,
        messages=messages,
        stream=stream,
        temperature=0.7,
        max_tokens=200
    )

    if stream:
        # 流式返回
        for chunk in response:
            if chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content
    else:
        # 一次性返回
        return response.choices[0].message.content

def main():
    """示例用法"""
    print(f"Using API: {BASE_URL}")
    print(f"Using Model: {MODEL}")
    print("-" * 50)

    # 非流式请求
    print("Non-streaming example:")
    messages = [{"role": "user", "content": "你好，请简单介绍一下自己"}]
    response = chat_completion(messages, stream=False)
    print(f"Response: {response}")
    print("-" * 50)

    # 流式请求
    print("\nStreaming example:")
    messages = [{"role": "user", "content": "用一句话介绍人工智能"}]
    print("Response: ", end="", flush=True)
    for chunk in chat_completion(messages, stream=True):
        print(chunk, end="", flush=True)
    print("\n" + "-" * 50)

if __name__ == "__main__":
    main()
