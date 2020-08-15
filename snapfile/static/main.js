function updateScroll(){
    var element = document.getElementById("middle");
    element.scrollTop = element.scrollHeight;
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
    // =====BEGIN=====Messaging
    var conn = null; // websocket
    var connected = false;
    var err_acc = 0;
    var msg_count = 0;
    var textarea = $('textarea');
    var send = $('input#send_message');

    // display a single message
    function display(msg) {
        var tr = $('<tr>');
        if (msg.type == 0) {
            // TEXT
            // use text instead of html to avoid xss attack
            tr.append($('<td colspan="2">').text(msg.data));
        }
        else if (msg.type == 1) {
            //  FILE
            const params = new URLSearchParams({
                id: msg.file_id,
                name: msg.data,
            });
            var a = $('<a target="_blank">').attr('href', '/files?' + params.toString()).text(msg.data);
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
                    info.identity = localStorage.getItem("identity");
                    update_status(info);
                    conn.send(JSON.stringify({
                        action: 'pull',
                        offset: msg_count
                    }));
                    break;
                case 'send':
                    data.msgs.forEach(msg => display(msg));
                    updateScroll();
                    msg_count += data.msgs.length;
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
        console.log('yes');
        $('#toggle').toggleClass('on');
        $('#menu').slideToggle();
    });

    send.on('click', function() {
        var text = textarea.val();
        if (text) {
            // console.log('send');
            conn.send(JSON.stringify({
                action: 'send',
                data: text
            }));
            textarea.val('');
            if( ! /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ) {
                textarea.focus(); // bad UE on mobile
            }
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
        if (modal.is(':empty')) {
            const params = new URLSearchParams({
                identity: localStorage.getItem("identity")
            });
            new QRCode(document.getElementById("qrcode"), window.location.origin + '/login.html?' + params.toString());
        }
        modal.addClass("on");
    });

    connect(); // connect immediately
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
    var options = {
        beforeSubmit: function(formData, jqForm, options) {
            // is this the right way to preserve some custom data between callbacks?
            this.startTime = Date.now(); // current time in milliseconds
            this.total = 0;
            for (var i=0; i < formData.length; i++) {
                this.total += formData[i].value.size;
            }
            this.lastTime = this.startTime;
            this.lastPosition = 0;
            percent.text('0%');
        },
        uploadProgress: function(event, position, total, percentComplete) {
            // don't know
            // If I initiate lastTime and lastPosition in beforeSend, they won't be available here
            // If I initiate total in beforeSubmit, it is available here but
            // if I set total here, it is not available in complete
            // console.log('upload...');
            var time = Date.now();
            var timeSpan = time - this.lastTime;
            if (timeSpan > 500) {
                var speed = (position - this.lastPosition) / timeSpan; // KB/s
                percent.text(percentComplete + '% ' + formatSize(speed) + 'B/s');
                this.lastTime = time;
                this.lastPosition = position;
            }
        },
        complete: function(xhr, textStatus) {
            // success or error
            if (xhr.status == 431) {
                alert('Sorry! Your storage space is not enough!');
            }
            else if (xhr.status == 413) {
                // NGINX will return html directly
                xhr.responseText = '413 Request Entity Too Large';
            }
            else if (xhr.status == 200) {
                // avg speed
                var speed = this.total / (Date.now() - this.startTime); // KB
                xhr.responseText += ' (' + formatSize(speed) + 'B/s)';
            }
            percent.text(textStatus + ': ' + xhr.responseText);
            toggleUpload();
        }
    };
    // forward the click event
    upload_btn.click(function () {
        file_input.trigger('click');
    });
    cancel_upload_btn.click(function () {
        var xhr = form.data('jqxhr');
        xhr.responseText = 'Canceled';
        xhr.abort();
    });
    // listen on select file
    file_input.on('change', function(){
        if (this.value) {
            // submit when the field is not empty
            // i.e., uploading immediately after selecting file(s)
            form = $("form#file").ajaxSubmit(options);
            // checkout https://stackoverflow.com/questions/12030686/html-input-file-selection-event-not-firing-upon-selecting-the-same-file
            this.value = null;
            toggleUpload();
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
        var files = e.originalEvent.dataTransfer.files;
        file_input.prop('files', files);
        file_input.trigger("change");
        return false;
    });
    // ======END======
});