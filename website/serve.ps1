param([int]$port = 4440)

# The page reads WAX over CORS, so it has to be served over http:// - opening
# index.html from the filesystem gives it a `null` origin and every node
# refuses the preflight.
$serverPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$httpListener = New-Object System.Net.HttpListener
$httpListener.Prefixes.Add("http://127.0.0.1:$port/")
$httpListener.Start()
Write-Host "DAO Master - Alien Worlds councils"
Write-Host "Server started on http://127.0.0.1:$port/"
Write-Host "Press Ctrl+C to stop"

while ($true) {
    $context = $httpListener.GetContext()
    $request = $context.Request
    $response = $context.Response

    $filePath = Join-Path $serverPath ([System.Uri]::UnescapeDataString($request.Url.AbsolutePath).TrimStart('/'))

    if ([string]::IsNullOrWhiteSpace([System.Uri]::UnescapeDataString($request.Url.AbsolutePath)) -or $request.Url.AbsolutePath -eq '/') {
        $filePath = Join-Path $serverPath 'index.html'
    }

    # No revalidation info is sent with these responses, so a browser is free to
    # heuristically cache them - which during development means editing app.js
    # and seeing the old one until a hard refresh.
    $response.Headers.Add('Cache-Control', 'no-cache, no-store, must-revalidate')

    if (Test-Path $filePath -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
        $response.ContentType = switch ($ext) {
            '.html' { 'text/html; charset=utf-8' }
            '.css'  { 'text/css; charset=utf-8' }
            '.js'   { 'application/javascript; charset=utf-8' }
            '.json' { 'application/json; charset=utf-8' }
            '.png'  { 'image/png' }
            '.jpg'  { 'image/jpeg' }
            '.svg'  { 'image/svg+xml' }
            '.ico'  { 'image/x-icon' }
            default { 'application/octet-stream' }
        }

        $stream = [System.IO.File]::OpenRead($filePath)
        try {
            $response.ContentLength64 = $stream.Length
            $stream.CopyTo($response.OutputStream)
        } finally {
            $stream.Dispose()
        }
    } else {
        $response.StatusCode = 404
        $buffer = [System.Text.Encoding]::UTF8.GetBytes('File not found')
        $response.OutputStream.Write($buffer, 0, $buffer.Length)
    }

    $response.OutputStream.Close()
}
