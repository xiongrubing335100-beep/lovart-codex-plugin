"""Offline transport fixture. Does not import the Lovart client or access the network."""
import sys, json, pathlib, base64

args = sys.argv[1:]
if args[0] == 'config':
    print(json.dumps({'project_id': 'fixture-project'}))
elif args[0] == 'threads':
    print('[]')
elif args[0] == 'chat':
    output = pathlib.Path(args[args.index('--output-dir') + 1])
    output.mkdir(parents=True, exist_ok=True)
    file = output / 'fixture.png'
    file.write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='))
    url = 'https://a.lovart.ai/fixture.png'
    print(json.dumps({'thread_id': 'fixture-thread', 'project_id': 'fixture-project', 'final_status': 'done',
        'items': [{'artifacts': [{'type': 'image', 'content': url}]}],
        'downloaded': [{'type': 'image', 'url': url, 'local_path': str(file), 'new': True}]}))
else:
    raise RuntimeError('Unexpected fixture command')
