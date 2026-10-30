local function image(source)
  if not source:match("^%s*<[iI][mM][gG]%s[^<>]*>%s*$") then return nil end
  local ok, document = pcall(pandoc.read, source, "html")
  if not ok then return nil end
  local result
  document:walk({ Image = function(value) if not result then result = value end end })
  return result
end

function RawInline(inline)
  if inline.format == "html" then return image(inline.text) end
end

function RawBlock(block)
  if block.format ~= "html" then return nil end
  local value = image(block.text)
  if value then return pandoc.Para({ value }) end
end
