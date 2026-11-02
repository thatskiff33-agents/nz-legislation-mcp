Put your Legislation API key in a file named `legislation_api_key` in this folder (one line), then make it readable only by the container's user (uid 65532):

    sudo chown 65532:65532 legislation_api_key
    sudo chmod 400 legislation_api_key

It is ignored by git and passed to the container as a Docker secret. Do not make it world-readable.
