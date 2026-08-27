"""Unit tests for demote_stale_tool_images / 413 vision payload hygiene."""

from agent.message_sanitization import (
    demote_stale_tool_images,
    _strip_images_from_messages,
)


def _vision_tool(i: int, *, with_image: bool = True):
    parts = [{"type": "text", "text": f"shot {i}"}]
    if with_image:
        parts.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{'x' * 100}{i}"},
            }
        )
    return {
        "role": "tool",
        "tool_call_id": f"call_{i}",
        "name": "vision_analyze",
        "content": parts,
    }


def test_demote_keeps_newest_n_images():
    msgs = [{"role": "user", "content": "qa"}]
    for i in range(5):
        msgs.append(
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": f"call_{i}",
                        "type": "function",
                        "function": {"name": "vision_analyze", "arguments": "{}"},
                    }
                ],
            }
        )
        msgs.append(_vision_tool(i))

    demoted = demote_stale_tool_images(msgs, keep_last=2)
    assert demoted == 3
    tools = [m for m in msgs if m.get("role") == "tool"]
    assert all(isinstance(t["content"], str) for t in tools[:3])
    assert all("data:image" not in str(t["content"]) for t in tools[:3])
    assert all(isinstance(t["content"], list) for t in tools[3:])
    assert all("data:image" in str(t["content"]) for t in tools[3:])


def test_demote_noop_when_under_cap():
    msgs = [_vision_tool(0), _vision_tool(1)]
    assert demote_stale_tool_images(msgs, keep_last=2) == 0
    assert all(isinstance(m["content"], list) for m in msgs)


def test_strip_images_handles_multimodal_envelope():
    msgs = [
        {
            "role": "tool",
            "tool_call_id": "c1",
            "content": {
                "_multimodal": True,
                "text_summary": "Image attached natively (120.0 KB).",
                "content": [
                    {"type": "text", "text": "Image loaded"},
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:image/png;base64,abc"},
                    },
                ],
            },
        }
    ]
    assert _strip_images_from_messages(msgs) is True
    assert msgs[0]["content"] == "Image attached natively (120.0 KB)."
    assert "data:image" not in str(msgs[0]["content"])
