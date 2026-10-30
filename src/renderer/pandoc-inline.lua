-- Preserve the supported HTML spellings when a script mark cannot use a
-- single delimiter beside another mark (for example <sub>~~text~~</sub>).
function Inlines(inlines)
  local output, stack = pandoc.List(), {}
  local function append(inline)
    local target = #stack > 0 and stack[#stack].content or output
    target:insert(inline)
  end
  for _, inline in ipairs(inlines) do
    local text = inline.t == "RawInline" and inline.format == "html" and inline.text:lower() or ""
    local opening = text == "<sub>" and "sub" or text == "<sup>" and "sup" or nil
    local closing = text == "</sub>" and "sub" or text == "</sup>" and "sup" or nil
    if opening then
      stack[#stack + 1] = { tag = opening, opening = inline, content = pandoc.List() }
    elseif closing and #stack > 0 and stack[#stack].tag == closing then
      local item = table.remove(stack)
      append(closing == "sub" and pandoc.Subscript(item.content) or pandoc.Superscript(item.content))
    else
      append(inline)
    end
  end
  while #stack > 0 do
    local item = table.remove(stack)
    append(item.opening)
    for _, inline in ipairs(item.content) do append(inline) end
  end
  return output
end
