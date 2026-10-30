-- Keep imported images editable as Markdown instead of raw HTML figures.
function Image(image)
  image.attr = pandoc.Attr()
  return image
end

function Figure(figure)
  return figure.content
end
