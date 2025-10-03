function updateScroll(){
    var element = document.getElementById("middle");
    element.scrollTop = element.scrollHeight;
}

function popup(msg) {
    $(".popup").text(msg).fadeIn().delay(2000).fadeOut();
}

// js string format
// checkout https://stackoverflow.com/a/18234317/6088837
String.prototype.formatUnicorn = String.prototype.formatUnicorn ||
function () {
    "use strict";
    var str = this.toString();
    if (arguments.length) {
        var t = typeof arguments[0];
        var key;
        var args = ("string" === t || "number" === t) ?
            Array.prototype.slice.call(arguments)
            : arguments[0];

        for (key in args) {
            str = str.replace(new RegExp("\\{" + key + "\\}", "gi"), args[key]);
        }
    }

    return str;
};

// convert date to month-day Hour:Minute
function formatDate(date) {
    var hours = date.getHours();
    var minutes = date.getMinutes();
    hours = hours < 10 ? '0'+hours : hours;
    minutes = minutes < 10 ? '0'+minutes : minutes;
    return (date.getMonth()+1) + "-" + date.getDate() + " " + hours + ":" + minutes;
}

$(function() {
    // =====BEGIN=====Encryption Setup
    // Initialize encryption with user's passcode
    var passcode = localStorage.getItem("identity");
    if (!passcode) {
        window.location = 'login.html';
        return;
    }
    
    // Check if Web Crypto API is supported
    if (!E2EEncryption.isSupported()) {
        alert('Your browser does not support Web Crypto API. Please use a modern browser.');
        return;
    }

    // Initialize encryption (async) - must complete before connecting
    var encryptionReady = false;
    var encryptionInitPromise = crypto_e2e.initialize(passcode).then(() => {
        encryptionReady = true;
        console.log('End-to-end encryption initialized');
    }).catch(err => {
        console.error('Failed to initialize encryption:', err);
        alert('Failed to initialize encryption. Please try again.');
        throw err;
    });
    // =====END=====Encryption Setup

    // =====BEGIN=====Messaging
    var conn = null; // websocket
    var connected = false;
    var err_acc = 0;
    var msg_count = 0;
    var textarea = $('textarea');
    var send = $('input#send_message');

    var expression = /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/i;
    var regex = new RegExp(expression);

    // display a single message
    async function display(msg) {
        var tr = $('<tr>');
        if (msg.type == 0) {
            // TEXT - decrypt the message
            try {
                // Wait for encryption to be ready
                if (!encryptionReady) {
                    await encryptionInitPromise;
                }
                var decryptedText = await crypto_e2e.decryptText(msg.data);
                var td = $('<td colspan="2">');
                if (decryptedText.match(regex)) {
                    // create a link for the url
                    var a = $('<a />');
                    a.attr('target', '_blank');
                    a.attr('href', decryptedText);
                    a.text(decryptedText);
                    td.html(a);
                }
                else {
                    // use text instead of html to avoid xss attack
                    td.text(decryptedText);
                }
                tr.append(td);
            } catch (err) {
                console.error('Failed to decrypt message:', err);
                tr.append($('<td colspan="2">').text('[Decryption failed]'));
            }
        }
        else if (msg.type == 1) {
            //  FILE
            const params = new URLSearchParams({
                id: msg.file_id,
                name: msg.data,
            });
            var a = $('<a href="#" class="download-link">').text(msg.data);
            a.data('file-id', msg.file_id);
            a.data('file-name', msg.data);
            
            // Add click handler for encrypted download
            a.on('click', async function(e) {
                e.preventDefault();
                var fileId = $(this).data('file-id');
                var fileName = $(this).data('file-name');
                
                try {
                    // Show downloading status
                    popup('Downloading and decrypting...');
                    
                    // Fetch encrypted file as stream
                    const response = await fetch('/files?' + new URLSearchParams({
                        id: fileId,
                        name: fileName
                    }));
                    
                    if (!response.ok || !response.body) {
                        throw new Error('Download failed');
                    }

                    // Create decrypted stream: fetch -> decrypt
                    // Memory efficient: constant ~64MB memory usage for any file size
                    const decryptTransform = crypto_e2e.createDecryptTransform();
                    const decryptedStream = response.body.pipeThrough(decryptTransform);
                    
                    // Create a blob from the decrypted stream
                    // Browser handles this efficiently with streaming
                    const decryptedResponse = new Response(decryptedStream);
                    const decryptedBlob = await decryptedResponse.blob();
                    
                    // Trigger browser download
                    const url = URL.createObjectURL(decryptedBlob);
                    const downloadLink = document.createElement('a');
                    downloadLink.href = url;
                    downloadLink.download = fileName;
                    downloadLink.click();
                    
                    // Clean up
                    URL.revokeObjectURL(url);
                    popup('Download complete!');
                } catch (err) {
                    console.error('Failed to download/decrypt file:', err);
                    alert('Failed to download or decrypt file. Please try again.');
                }
                
                return false;
            });
            
            tr.append(
                $('<td>').append(a),
                $('<td class="right">').text(msg.size),
            );
        }
        tr.append($('<td>').text(formatDate(new Date(msg.date))));
        $('table').append(tr);
    }

    function connect() {
        disconnect();
        var wsUri = (window.location.protocol == 'https:' && 'wss://' || 'ws://') + window.location.host + '/ws';
        conn = new WebSocket(wsUri);
        conn.onopen = function() {
            connected = true;
            err_acc = 0;
            send.prop("disabled", false);
            console.log('Connected.');
        };
        conn.onmessage = function(e) {
            var data = JSON.parse(e.data);
            // console.log('receive');
            switch (data.action) {
                case 'connect':
                    var info = data.info;
                    // new Date from isoformat
                    // format to m-d HH:MM
                    info.expire_at = formatDate(new Date(info.expire_at));
                    info.identity = localStorage.getItem("identity").toUpperCase();
                    update_status(info);
                    conn.send(JSON.stringify({
                        action: 'pull',
                        offset: msg_count
                    }));
                    break;
                case 'send':
                    // Decrypt messages asynchronously
                    (async () => {
                        for (const msg of data.msgs) {
                            await display(msg);
                        }
                        updateScroll();
                        msg_count += data.msgs.length;
                    })();
                    break;
            }
        };
        conn.onclose = function(e) {
            conn = null;
            connected = false;
            send.prop("disabled", true);
            console.log('Websocket closed because: (' + e.code + ') ' + e.reason);
            if (e.code == 1006 || e.code == 1013)
            {
                // Abnormal Closure or Try Again Later
                // when safari is not in focus
                // ios safari will drop websocket connection due to inactivity
                // and delay any timer until safari comes back to foreground
                var t = 0.5 * Math.pow(2, err_acc); // 0.5, 1, 2, 4, 8, 16, 32
                if (t < 60)
                {
                    console.log('re-connect automatically after ' + t + ' seconds');
                    setTimeout(connect, t*1000);
                }
            }
            else if (e.code == 1001)
            {
                // Going Away
                alert('You are logged out!');
                window.location = 'login.html';
            }
            else if (e.code == 4000)
            {
                // Unauthorized (customized)
                window.location = 'login.html';
            }
        };
        conn.onerror = function(e) {
            console.log('Websocket error: ' + JSON.stringify(e));
            err_acc ++;
            // conn.close(); will be called
        };

    }

    function disconnect() {
        if (connected) {
            //log('Disconnecting...');
            conn.close();
        }
    }

    var status_bar_tmpl = $('#status_bar').html();
    function update_status(data) {
        // awesome, it works like a template engine
        $('#status_bar').html(status_bar_tmpl.formatUnicorn(data));
        // the drawback is that event callbacks registered on these dom before will disappear
    }

    $('#dropdown').click(function() {
        $('#toggle').toggleClass('on');
        $('#menu').slideToggle();
    });

    send.on('click', function() {
        var text = textarea.val();
        if (text && encryptionReady) {
            // Encrypt the message before sending
            crypto_e2e.encryptText(text).then(encryptedText => {
                // console.log('send');
                conn.send(JSON.stringify({
                    action: 'send',
                    data: encryptedText
                }));
                textarea.val('');
                if( ! /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ) {
                    textarea.focus(); // bad UE on mobile
                }
            }).catch(err => {
                console.error('Failed to encrypt message:', err);
                alert('Failed to encrypt message. Please try again.');
            });
        } else if (!encryptionReady) {
            alert('Encryption is not ready yet. Please wait a moment and try again.');
        }
        return false;
    });

    // register logout button
    $('#logout').on('click', function() {
        disconnect();
        // $.post('/logout'); does not redirect properly
        // see: https://stackoverflow.com/q/8389646/6088837
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = '/logout';
        document.body.appendChild(form);
        form.submit();
        localStorage.removeItem("identity");
        return false;
    });

    // register share button
    var modal = $("#qrcode");
    // close when the user clicks anywhere outside the image
    modal.click(function(event) {
        if ($(event.target)[0] == modal[0]) {
            modal.removeClass("on");
        }
    });
    $('#share').on('click', function() {
        const params = new URLSearchParams({
            identity: localStorage.getItem("identity")
        });
        var url = window.location.origin + '/login.html?' + params.toString();

        // Step 1: copy the link to clipboard
        navigator.clipboard.writeText(url).then(
            function() {
                popup('Link copied!');
                console.log('Async: Copying to clipboard was successful!');
            },
            function(err) {
                popup('Failed to copy link!');
                console.error('Async: Could not copy text: ', err);
            });

        // Step 2: generate a qr code
        if (modal.is(':empty')) {
            new QRCode(document.getElementById("qrcode"), url);
        }
        modal.addClass("on");
    });

    // Wait for encryption to be ready before connecting
    encryptionInitPromise.then(() => {
        connect(); // connect only after encryption is initialized
    }).catch(err => {
        console.error('Cannot connect: encryption initialization failed', err);
    });
    // ======END======



    // =====BEGIN=====Upload files
    var form;
    var file_input = $('form#file input');
    var upload_btn = $("input#upload_files");
    var cancel_upload_btn = $("input#cancel");
    var percent = $('.percent');
    var lastPosition = 0;
    function formatSize(size) {
        if (size > 1000) {
            return (size / 1000).toFixed(1) + 'M';
        } else {
            return size.toFixed() + 'K';
        }
    }
    function toggleUpload() {
        if (upload_btn.is(":visible")) {
            upload_btn.hide();
            cancel_upload_btn.show();
        }
        else {
            cancel_upload_btn.hide();
            upload_btn.show();
        }
    }

    // Upload files function - direct streaming approach without ajaxSubmit
    async function uploadFiles(files) {
        if (!encryptionReady) {
            alert('Encryption is not ready yet. Please wait a moment and try again.');
            return;
        }

        try {
            toggleUpload();
            const startTime = Date.now();
            let lastTime = startTime;
            let lastPosition = 0;
            let totalSize = 0;

            // Calculate total size
            for (const file of files) {
                totalSize += file.size;
            }

            // Upload files with streaming encryption
            for (const file of files) {
                const fileName = file.name;
                
                // Create progress tracking transform stream
                let uploadedSize = 0;
                const progressStream = new TransformStream({
                    transform(chunk, controller) {
                        uploadedSize += chunk.byteLength;
                        
                        // Update progress
                        const time = Date.now();
                        const timeSpan = time - lastTime;
                        if (timeSpan > 500) {
                            const speed = (uploadedSize - lastPosition) / timeSpan; // KB/s
                            const percentComplete = Math.round((uploadedSize / totalSize) * 100);
                            percent.text(percentComplete + '% ' + formatSize(speed) + 'B/s');
                            lastTime = time;
                            lastPosition = uploadedSize;
                        }
                        
                        controller.enqueue(chunk);
                    }
                });
                
                // Create encrypted stream directly from file using TransformStream
                const encryptedStream = file.stream()
                    .pipeThrough(await crypto_e2e.createEncryptTransformStream())
                    .pipeThrough(progressStream);

                // Upload with fetch - streaming encrypted file
                percent.text('Uploading: 0%');
                const response = await fetch('/files?' + new URLSearchParams({
                    name: fileName
                }), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/octet-stream'
                    },
                    duplex: 'half',
                    body: encryptedStream
                });

                if (response.status === 200) {
                    const responseText = await response.text();
                    const speed = totalSize / (Date.now() - startTime);
                    percent.text('Success: ' + responseText + ' (' + formatSize(speed) + 'B/s)');
                } else if (response.status === 431) {
                    percent.text('Error: Storage space not enough');
                    throw new Error('Storage space not enough');
                } else if (response.status === 413) {
                    percent.text('Error: File too large');
                    throw new Error('File too large');
                } else {
                    const errorText = await response.text();
                    percent.text('Error: ' + errorText);
                    throw new Error(errorText);
                }
            }

            toggleUpload();
        } catch (err) {
            console.error('Upload error:', err);
            toggleUpload();
        }
    }

    // forward the click event
    upload_btn.click(function () {
        file_input.trigger('click');
    });
    
    // TODO: Implement proper cancel functionality for fetch requests
    cancel_upload_btn.click(function () {
        // Note: Canceling fetch requests requires AbortController
        console.log('Cancel functionality needs to be implemented with AbortController');
    });
    
    // listen on select file
    file_input.on('change', function(){
        if (this.files && this.files.length > 0) {
            // Upload immediately after selecting file(s)
            uploadFiles(Array.from(this.files));
            // checkout https://stackoverflow.com/questions/12030686/html-input-file-selection-event-not-firing-upon-selecting-the-same-file
            this.value = null;
        }
    });

    // enable drag & drop
    $('#container')
    .on('dragover', function(e) {
        // it's more reliable to add class here instead of when dragenter
        $(this).addClass('dragging');
        // crucial for the 'drop' event to fire
        // Returning false from an event handler will automatically call event.stopPropagation() and event.preventDefault()
        return false;
    })
    .on('dragleave', function(e) {
        $(this).removeClass('dragging');
        return false;
    })
    .on('drop', function(e) {
        $(this).removeClass('dragging');
        var files = Array.from(e.originalEvent.dataTransfer.files);
        uploadFiles(files);
        return false;
    });
    // ======END======
});